import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { pollUntil } from "../host/polling";

test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "exec releases its lease after the child handles %s",
  async (signal) => {
    const root = mkdtempSync(path.join(tmpdir(), "branchbase-cli-signal-"));
    const childFile = path.join(root, "child.ts");
    writeFileSync(
      childFile,
      `import {writeFileSync} from 'node:fs';
    for(const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal,()=>setTimeout(()=>{writeFileSync('stopped',signal);process.exit(0)},30));
    writeFileSync('ready',String(process.pid));setInterval(()=>{},1000);`
    );
    const runner = `import {writeFileSync,existsSync} from 'node:fs';
    import {DaemonClient} from ${JSON.stringify(new URL("client.ts", import.meta.url).href)};
    import {runCli} from ${JSON.stringify(new URL("run.ts", import.meta.url).href)};
    const runtime={buildId:'signal-test',installationPath:'/test',version:'test'};
    const client=new DaemonClient('http://localhost:3999',(url)=>{
      if(url.pathname==='/api/health')return Promise.resolve(Response.json({ok:true,pid:process.pid,service:'branchbase',runtime}));
      if(url.pathname.endsWith('/session'))return Promise.resolve(Response.json({token:'test'}));
      if(url.pathname.endsWith('/resource-command-context'))return Promise.resolve(Response.json({cwd:${JSON.stringify(root)},env:{},inputs:{},leaseId:'lease'}));
      writeFileSync('released',existsSync('stopped')?'after-child':'before-child');
      return Promise.resolve(Response.json({ok:true,command:'release-command-context',message:'Released'}));
    },runtime);
    await runCli(['exec','--worktree','main','--group','app','--',process.execPath,${JSON.stringify(childFile)}],client,${JSON.stringify(root)});`;
    const cli = spawn(process.execPath, ["--eval", runner], {
      cwd: root,
      stdio: "ignore",
    });
    const exited = once(cli, "exit");
    try {
      await pollUntil(() => existsSync(path.join(root, "ready")), {
        intervalMs: 20,
        message: "Child did not start",
        timeoutMs: 3000,
      });
      cli.kill(signal);
      const [code] = await exited;
      expect(code).toBe(0);
      expect(readFileSync(path.join(root, "stopped"), "utf-8")).toBe(signal);
      expect(readFileSync(path.join(root, "released"), "utf-8")).toBe(
        "after-child"
      );
    } finally {
      cli.kill("SIGKILL");
      try {
        process.kill(
          Number(readFileSync(path.join(root, "ready"), "utf-8")),
          "SIGKILL"
        );
      } catch {
        /* Test-owned child already exited. */
      }
      rmSync(root, { force: true, recursive: true });
    }
  }
);
