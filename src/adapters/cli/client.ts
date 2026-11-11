import {
  isBranchBaseCommandName,
  parseCommandInput,
  parseCommandResult,
} from "../../application/command-contract";
import {
  readRuntimeIdentity,
  RUNTIME_HEADER,
  RuntimeIdentitySchema,
  runtimeMismatchMessage,
} from "../../daemon/runtime-identity";
import type { RuntimeIdentity } from "../../daemon/runtime-identity";

export class DaemonClient {
  private readonly origin: string;
  private readonly runtime: RuntimeIdentity;
  private readonly transport: (
    url: URL,
    init?: RequestInit
  ) => Promise<Response>;

  constructor(
    origin: string,
    transport: (url: URL, init?: RequestInit) => Promise<Response> = fetch,
    runtime: RuntimeIdentity = readRuntimeIdentity()
  ) {
    this.origin = origin;
    this.transport = transport;
    this.runtime = runtime;
  }

  async verifyRuntime(expectedPid?: number): Promise<void> {
    const response = await this.transport(new URL("/api/health", this.origin), {
      signal: AbortSignal.timeout(5000),
    });
    const body = await DaemonClient.read(response);
    if (
      !body ||
      typeof body !== "object" ||
      !("service" in body) ||
      body.service !== "branchbase" ||
      !("ok" in body) ||
      body.ok !== true ||
      !("pid" in body) ||
      !Number.isInteger(body.pid)
    ) {
      throw new Error("The endpoint is not a healthy BranchBase daemon.");
    }
    if (expectedPid !== undefined && body.pid !== expectedPid) {
      throw new Error(
        `The daemon endpoint belongs to PID ${body.pid}, not recorded PID ${expectedPid}. Check BRANCHBASE_PORT and the daemon status.`
      );
    }
    const actual = RuntimeIdentitySchema.safeParse(
      "runtime" in body ? body.runtime : undefined
    );
    if (
      !actual.success ||
      actual.data.buildId !== this.runtime.buildId ||
      actual.data.installationPath !== this.runtime.installationPath ||
      actual.data.version !== this.runtime.version
    ) {
      throw new Error(
        runtimeMismatchMessage(
          this.runtime,
          actual.success ? actual.data : undefined
        )
      );
    }
  }

  async query(
    path: string,
    parameters: Record<string, string> = {}
  ): Promise<unknown> {
    await this.verifyRuntime();
    const url = new URL(path, this.origin);
    url.search = new URLSearchParams(parameters).toString();
    return DaemonClient.read(
      await this.transport(url, {
        headers: { [RUNTIME_HEADER]: this.runtime.buildId },
        signal: AbortSignal.timeout(15_000),
      })
    );
  }

  async execute(command: string, input: unknown): Promise<unknown> {
    if (!isBranchBaseCommandName(command)) {
      throw new Error(`Unknown command: ${command}`);
    }
    const parsed = parseCommandInput(command, input);
    const session = await this.query("/api/session");
    if (
      !session ||
      typeof session !== "object" ||
      !("token" in session) ||
      typeof session.token !== "string"
    ) {
      throw new Error("Invalid daemon session");
    }
    // A command may outlive a transport connection. Never automatically replay it.
    const response = await this.transport(
      new URL(`/api/commands/${command}`, this.origin),
      {
        body: JSON.stringify(parsed),
        headers: {
          [RUNTIME_HEADER]: this.runtime.buildId,
          "content-type": "application/json",
          "x-branchbase-token": session.token,
        },
        method: "POST",
      }
    );
    return parseCommandResult(command, await DaemonClient.read(response));
  }

  private static async read(response: Response): Promise<unknown> {
    const body: unknown = await response.json();
    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : `Daemon request failed (${response.status})`;
      throw new Error(message);
    }
    return body;
  }
}
