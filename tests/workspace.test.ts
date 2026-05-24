import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfigFile, resolveWorkspace } from "../src/workspace.js";

describe("resolveWorkspace", () => {
  test("defaults workspace to <cwd>/.ralphloop and repoRoot to <cwd>", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "rw-defaults-"));
    const r = resolveWorkspace({ cwd, envVars: {}, cliFlags: {} });
    expect(r.workspaceDir).toBe(resolve(cwd, ".ralphloop"));
    expect(r.repoRoot).toBe(cwd);
    expect(r.configPath).toBe(resolve(cwd, ".ralphloop", "config.yaml"));
    expect(r.configData).toBeNull();
  });

  test("CLI --workspace beats env RALPH_WORKSPACE_DIR", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "rw-prec-cli-"));
    const r = resolveWorkspace({
      cwd,
      envVars: { RALPH_WORKSPACE_DIR: "/etc/env-workspace" },
      cliFlags: { workspace: "/etc/cli-workspace" },
    });
    expect(r.workspaceDir).toBe("/etc/cli-workspace");
  });

  test("env RALPH_WORKSPACE_DIR is used when CLI flag absent", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "rw-prec-env-"));
    const r = resolveWorkspace({
      cwd,
      envVars: { RALPH_WORKSPACE_DIR: "/etc/env-workspace" },
      cliFlags: {},
    });
    expect(r.workspaceDir).toBe("/etc/env-workspace");
  });

  test("config.repoRoot is honoured when CLI/env absent", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "rw-cfg-repo-"));
    mkdirSync(resolve(cwd, ".ralphloop"));
    writeFileSync(
      resolve(cwd, ".ralphloop", "config.yaml"),
      "repoRoot: /opt/my-project\n",
    );
    const r = resolveWorkspace({ cwd, envVars: {}, cliFlags: {} });
    expect(r.repoRoot).toBe("/opt/my-project");
  });

  test("CLI --repo beats config.repoRoot", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "rw-cfg-cli-repo-"));
    mkdirSync(resolve(cwd, ".ralphloop"));
    writeFileSync(
      resolve(cwd, ".ralphloop", "config.yaml"),
      "repoRoot: /opt/config-repo\n",
    );
    const r = resolveWorkspace({
      cwd,
      envVars: {},
      cliFlags: { repo: "/opt/cli-repo" },
    });
    expect(r.repoRoot).toBe("/opt/cli-repo");
  });

  test("loads a non-trivial config file", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "rw-cfg-data-"));
    mkdirSync(resolve(cwd, ".ralphloop"));
    writeFileSync(
      resolve(cwd, ".ralphloop", "config.yaml"),
      [
        "goal: my-spec.md",
        "maxIterations: 7",
        "commit:",
        "  taskPrefix: feat",
        "  reviewPrefix: chore",
        "claude:",
        "  bin: anthropic",
        "  model: super-model",
      ].join("\n"),
    );
    const r = resolveWorkspace({ cwd, envVars: {}, cliFlags: {} });
    expect(r.configData?.goal).toBe("my-spec.md");
    expect(r.configData?.maxIterations).toBe(7);
    expect(r.configData?.commit?.taskPrefix).toBe("feat");
    expect(r.configData?.commit?.reviewPrefix).toBe("chore");
    expect(r.configData?.claude?.bin).toBe("anthropic");
    expect(r.configData?.claude?.model).toBe("super-model");
  });
});

describe("loadConfigFile", () => {
  test("returns null when file is absent", () => {
    expect(loadConfigFile("/no/such/file.yaml")).toBeNull();
  });

  test("returns null on malformed YAML", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "rw-malformed-"));
    const p = resolve(cwd, "cfg.yaml");
    writeFileSync(p, "key: [unclosed");
    expect(loadConfigFile(p)).toBeNull();
  });

  test("returns null when YAML parses to a scalar (not an object)", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "rw-scalar-"));
    const p = resolve(cwd, "cfg.yaml");
    writeFileSync(p, "just a string\n");
    expect(loadConfigFile(p)).toBeNull();
  });
});
