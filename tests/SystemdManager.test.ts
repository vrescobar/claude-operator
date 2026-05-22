import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  renderUnit,
  sanitize,
  serviceNameFor,
  unitPath,
  type UnitSpec,
} from "../src/SystemdManager.js";

describe("sanitize", () => {
  test("lowercases and collapses non-alphanumerics into dashes", () => {
    expect(sanitize("My Cool Project!")).toBe("my-cool-project");
  });

  test("preserves underscores and existing dashes", () => {
    expect(sanitize("foo_bar-baz")).toBe("foo_bar-baz");
  });

  test("strips leading/trailing dashes", () => {
    expect(sanitize("--weird--")).toBe("weird");
  });

  test("falls back to 'project' when everything is stripped", () => {
    expect(sanitize("###")).toBe("project");
  });
});

describe("serviceNameFor", () => {
  test("derives the service name from the repo's basename", () => {
    expect(serviceNameFor("/home/user/projects/food")).toBe("ralphloop-food.service");
  });

  test("normalizes weird basenames", () => {
    expect(serviceNameFor("/tmp/My App")).toBe("ralphloop-my-app.service");
  });
});

describe("unitPath", () => {
  test("points under ~/.config/systemd/user/", () => {
    expect(unitPath("ralphloop-food.service")).toBe(
      resolve(homedir(), ".config/systemd/user/ralphloop-food.service"),
    );
  });
});

describe("renderUnit", () => {
  const baseSpec: UnitSpec = {
    description: "ralphloop runloop for /opt/food",
    workingDirectory: "/opt/food",
    execCommand: "/usr/local/bin/bun",
    execArgs: ["/opt/ralphloop/bin/ralphloop.ts", "run", "--max-iterations", "10"],
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/user",
      RALPH_AGENT_BACKEND: "claude-p",
    },
  };

  test("contains the three systemd sections in order", () => {
    const out = renderUnit(baseSpec);
    expect(out.indexOf("[Unit]")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("[Service]")).toBeGreaterThan(out.indexOf("[Unit]"));
    expect(out.indexOf("[Install]")).toBeGreaterThan(out.indexOf("[Service]"));
  });

  test("renders ExecStart with the forwarded args joined by spaces", () => {
    const out = renderUnit(baseSpec);
    expect(out).toContain(
      "ExecStart=/usr/local/bin/bun /opt/ralphloop/bin/ralphloop.ts run --max-iterations 10",
    );
  });

  test("shell-quotes args that contain spaces or shell metacharacters", () => {
    const out = renderUnit({
      ...baseSpec,
      execArgs: ["/x.ts", "--goal", "/path with space/spec.md"],
    });
    expect(out).toContain("ExecStart=/usr/local/bin/bun /x.ts --goal '/path with space/spec.md'");
  });

  test("emits one Environment= line per env entry", () => {
    const out = renderUnit(baseSpec);
    expect(out).toContain("Environment=PATH=/usr/local/bin:/usr/bin:/bin");
    expect(out).toContain("Environment=HOME=/home/user");
    expect(out).toContain("Environment=RALPH_AGENT_BACKEND=claude-p");
  });

  test("includes Restart=on-failure and StandardOutput=journal", () => {
    const out = renderUnit(baseSpec);
    expect(out).toContain("Restart=on-failure");
    expect(out).toContain("StandardOutput=journal");
    expect(out).toContain("StandardError=journal");
  });

  test("WantedBy=default.target so `enable` is meaningful", () => {
    const out = renderUnit(baseSpec);
    expect(out).toContain("WantedBy=default.target");
  });

  test("skips empty-value env entries", () => {
    const out = renderUnit({ ...baseSpec, env: { PATH: "/bin", EMPTY: "" } });
    expect(out).toContain("Environment=PATH=/bin");
    expect(out).not.toContain("Environment=EMPTY=");
  });
});
