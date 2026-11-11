import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import pathModule from "node:path";
import { promisify } from "node:util";

import type { ViteDevServer } from "vite";

import { AppGroupLifecycleError } from "../../app-group/lifecycle-error";
import { isBranchBaseCommandName } from "../../application/command-contract";
import {
  MissingWorktreeConfigError,
  WorkspaceController,
} from "../../application/workspace-controller";
import { createCodexHookCapability } from "../../codex/codex-hook-capability";
import {
  CodexIntegrationSnapshotSchema,
  CodexIntegrationUnavailableError,
} from "../../codex/codex-integration";
import { ProductCatalogError } from "../../project/catalog";
import {
  ActivityResponseSchema,
  ProjectsResponseSchema,
} from "../../project/catalog-contract";
import {
  FoldersResponseSchema,
  ObservationSchema,
} from "../../project/discovery-contract";
import { ProjectStatusSchema } from "../../project/status-contract";
import { WorkspaceSnapshotSchema } from "../../project/worktree-status-contract";
import { processStartMarker } from "../host/process-inspection";
import {
  DAEMON_RESTART_INSTRUCTIONS,
  readRuntimeIdentity,
  RUNTIME_HEADER,
  RUNTIME_PATH_PREFIX,
} from "../host/runtime-identity";
import type { RuntimeIdentity } from "../host/runtime-identity";
import { createCodexHookRequestHandler } from "./codex-hook-route";
import {
  LogsQuerySchema,
  LogsResponseSchema,
  WorkspaceQuerySchema,
} from "./schemas";

const MAX_BODY = 64 * 1024;
const COMMAND_PATH = /^\/api\/commands\/(?<command>[a-z-]+)$/u;
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
};

export type BranchBaseServerController = Pick<
  WorkspaceController,
  "close" | "execute" | "handleCodexHook" | "inspect" | "inspectCodex" | "logs"
> &
  Partial<
    Pick<
      WorkspaceController,
      | "projects"
      | "activity"
      | "observeRepository"
      | "developmentFolders"
      | "refreshProjectStatus"
    >
  >;

export interface BranchBaseServerOptions {
  appRoot: string;
  codexControlDirectory?: string;
  controller?: BranchBaseServerController;
  development?: boolean;
  enableCodexHooks?: boolean;
  host?: string;
  port?: number;
  runtime?: RuntimeIdentity;
}

export interface BranchBaseServer {
  close: () => Promise<void>;
  listen: () => Promise<string>;
}

const createDevelopmentServer = async (
  appRoot: string
): Promise<ViteDevServer> => {
  const { createServer: createViteServer } = await import("vite");
  return createViteServer({
    appType: "spa",
    root: appRoot,
    server: { middlewareMode: true },
  });
};

const sendJson = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
};

const errorBody = (error: unknown) => {
  if (error instanceof ProductCatalogError) {
    return { code: error.code, error: error.message };
  }
  if (error instanceof CodexIntegrationUnavailableError) {
    return { code: error.code, error: error.message };
  }
  if (error instanceof MissingWorktreeConfigError) {
    return {
      code: error.code,
      configPath: error.configPath,
      error: error.message,
    };
  }
  if (error instanceof AppGroupLifecycleError) {
    return { code: error.code, error: error.message };
  }
  return { error: error instanceof Error ? error.message : String(error) };
};

const httpOrigin = (host: string, port: number): string => {
  const urlHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY) {
      throw new Error("Request body is too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
};

export const createBranchBaseServer = async (
  options: BranchBaseServerOptions
): Promise<BranchBaseServer> => {
  const runtime = options.runtime ?? readRuntimeIdentity();
  const controller = options.controller ?? new WorkspaceController();
  const host = options.host ?? "127.0.0.1";
  const configuredPort = options.port ?? 3999;
  const token = randomBytes(32).toString("base64url");
  const vite: ViteDevServer | null = options.development
    ? await createDevelopmentServer(options.appRoot)
    : null;
  let codexHookCapability: ReturnType<typeof createCodexHookCapability> | null =
    null;
  let handleCodexHook: ReturnType<typeof createCodexHookRequestHandler> | null =
    null;
  let exitCleanupRegistered = false;
  let listeningUrl: string | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const authorized = (request: IncomingMessage): boolean => {
    const { origin } = request.headers;
    const expectedOrigin = `http://${request.headers.host}`;
    return (
      request.headers["x-branchbase-token"] === token &&
      (!origin || origin === expectedOrigin)
    );
  };

  const handleDiscoveryGet = (url: URL, response: ServerResponse): boolean => {
    if (url.pathname === "/api/observation") {
      if (!controller.observeRepository) {
        sendJson(response, 501, {
          code: "observation-unavailable",
          error: "Repository observation is unavailable.",
        });
        return true;
      }
      sendJson(
        response,
        200,
        ObservationSchema.parse(
          controller.observeRepository(url.searchParams.get("repoPath") ?? "")
        )
      );
      return true;
    }
    if (url.pathname === "/api/development-folders") {
      sendJson(
        response,
        200,
        FoldersResponseSchema.parse({
          folders: controller.developmentFolders?.() ?? [],
        })
      );
      return true;
    }
    return false;
  };
  const handleGetApi = async (
    url: URL,
    response: ServerResponse
  ): Promise<boolean> => {
    if (url.pathname === "/api/project-status") {
      if (!controller.refreshProjectStatus) {
        sendJson(response, 501, {
          code: "project-status-unavailable",
          error: "Project status is unavailable",
        });
        return true;
      }
      const { repoPath } = WorkspaceQuerySchema.parse(
        Object.fromEntries(url.searchParams)
      );
      sendJson(
        response,
        200,
        ProjectStatusSchema.parse(controller.refreshProjectStatus(repoPath))
      );
      return true;
    }
    if (handleDiscoveryGet(url, response)) {
      return true;
    }
    if (url.pathname === "/api/projects") {
      sendJson(
        response,
        200,
        ProjectsResponseSchema.parse({
          projects: controller.projects?.() ?? [],
        })
      );
      return true;
    }
    if (url.pathname === "/api/activity") {
      sendJson(
        response,
        200,
        ActivityResponseSchema.parse({
          events:
            controller.activity?.(
              url.searchParams.get("repoPath") ?? undefined
            ) ?? [],
        })
      );
      return true;
    }
    if (url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        pid: process.pid,
        runtime,
        service: "branchbase",
      });
      return true;
    }
    if (url.pathname === "/api/session") {
      sendJson(response, 200, { token });
      return true;
    }
    if (url.pathname === "/api/workspace") {
      const { repoPath } = WorkspaceQuerySchema.parse(
        Object.fromEntries(url.searchParams)
      );
      sendJson(
        response,
        200,
        WorkspaceSnapshotSchema.parse(controller.inspect(repoPath))
      );
      return true;
    }
    if (url.pathname === "/api/codex") {
      const { repoPath } = WorkspaceQuerySchema.parse(
        Object.fromEntries(url.searchParams)
      );
      sendJson(
        response,
        200,
        CodexIntegrationSnapshotSchema.parse(
          await controller.inspectCodex(repoPath)
        )
      );
      return true;
    }
    if (url.pathname !== "/api/logs") {
      return false;
    }
    const { appGroupName, repoPath, worktreeId } = LogsQuerySchema.parse(
      Object.fromEntries(url.searchParams)
    );
    sendJson(
      response,
      200,
      LogsResponseSchema.parse({
        lines: controller.logs(repoPath, worktreeId, appGroupName),
      })
    );
    return true;
  };

  const handleCommand = async (
    request: IncomingMessage,
    response: ServerResponse,
    command: string
  ): Promise<void> => {
    if (!authorized(request)) {
      sendJson(response, 403, { error: "Invalid mutation session" });
      return;
    }
    if (
      !(request.headers["content-type"] ?? "").startsWith("application/json")
    ) {
      sendJson(response, 415, { error: "Commands require application/json" });
      return;
    }
    if (!isBranchBaseCommandName(command)) {
      sendJson(response, 404, { error: "Unknown command" });
      return;
    }
    const result = await controller.execute(command, await readJson(request));
    sendJson(response, 200, result);
  };

  const serveUi = (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): void => {
    if (vite) {
      // Vite's middleware API requires a Node-style completion callback.
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- required by the Vite middleware bridge
      vite.middlewares(request, response, (error: unknown) => {
        if (error) {
          sendJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        } else {
          response.writeHead(404).end("Not found");
        }
      });
      return;
    }
    const requested =
      url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = pathModule.join(options.appRoot, "dist", requested);
    if (!(existsSync(file) && statSync(file).isFile())) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type":
        CONTENT_TYPES[pathModule.extname(file)] ?? "application/octet-stream",
    });
    createReadStream(file).pipe(response);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      request.headers.host
        ? `http://${request.headers.host}`
        : httpOrigin(host, configuredPort)
    );
    try {
      if (url.pathname.startsWith(RUNTIME_PATH_PREFIX)) {
        const prefix = `${RUNTIME_PATH_PREFIX}${runtime.buildId}/`;
        if (!url.pathname.startsWith(prefix)) {
          sendJson(response, 409, {
            code: "daemon-build-mismatch",
            error: `CLI/daemon build mismatch. ${DAEMON_RESTART_INSTRUCTIONS}`,
          });
          return;
        }
        url.pathname = `/api/${url.pathname.slice(prefix.length)}`;
      }
      const expectedBuild = request.headers[RUNTIME_HEADER];
      if (expectedBuild !== undefined && expectedBuild !== runtime.buildId) {
        sendJson(response, 409, {
          code: "daemon-build-mismatch",
          error: `CLI/daemon build mismatch. ${DAEMON_RESTART_INSTRUCTIONS}`,
        });
        return;
      }
      if (
        handleCodexHook &&
        request.method === "POST" &&
        url.pathname === "/api/codex/hooks"
      ) {
        await handleCodexHook(request, response);
        return;
      }
      if (request.method === "GET" && (await handleGetApi(url, response))) {
        return;
      }
      const commandMatch =
        request.method === "POST" ? COMMAND_PATH.exec(url.pathname) : null;
      const command = commandMatch?.groups?.command;
      if (command !== undefined) {
        await handleCommand(request, response, command);
        return;
      }
      serveUi(request, response, url);
    } catch (error) {
      sendJson(
        response,
        error instanceof CodexIntegrationUnavailableError ? 503 : 400,
        errorBody(error)
      );
    }
  });

  const closeHttpServer = (): Promise<void> => {
    if (!server.listening) {
      return Promise.resolve();
    }
    return promisify(server.close.bind(server))();
  };

  const cleanupCodexHookCapability = (): void => {
    codexHookCapability?.cleanup();
  };

  const enableCodexHookBridge = (port: number): void => {
    if (options.enableCodexHooks === false) {
      return;
    }
    try {
      codexHookCapability = createCodexHookCapability({
        ...(options.codexControlDirectory
          ? { directory: options.codexControlDirectory }
          : {}),
        endpoint: `${httpOrigin(host, port)}/api/codex/hooks`,
        pid: process.pid,
        processStartMarker: processStartMarker(process.pid),
      });
      handleCodexHook = createCodexHookRequestHandler({
        observe: (observation) => controller.handleCodexHook(observation),
        token: codexHookCapability.record.token,
      });
      if (!exitCleanupRegistered) {
        process.once("exit", cleanupCodexHookCapability);
        exitCleanupRegistered = true;
      }
    } catch {
      codexHookCapability = null;
      handleCodexHook = null;
    }
  };

  return {
    close(): Promise<void> {
      shutdownPromise ??= (async () => {
        try {
          await Promise.all([
            closeHttpServer(),
            controller.close(),
            vite?.close() ?? Promise.resolve(),
          ]);
        } finally {
          if (exitCleanupRegistered) {
            process.off("exit", cleanupCodexHookCapability);
            exitCleanupRegistered = false;
          }
          cleanupCodexHookCapability();
        }
      })();
      return shutdownPromise;
    },
    async listen(): Promise<string> {
      if (listeningUrl) {
        return listeningUrl;
      }
      server.listen(configuredPort, host);
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("BranchBase server did not bind a TCP port");
      }
      enableCodexHookBridge(address.port);
      listeningUrl = `${httpOrigin(host, address.port)}/`;
      return listeningUrl;
    },
  };
};
