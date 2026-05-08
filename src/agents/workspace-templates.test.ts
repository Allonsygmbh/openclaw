import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetWorkspaceTemplateDirCache,
  resolveWorkspaceTemplateDir,
} from "./workspace-templates.js";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-templates-"));
  tempDirs.push(root);
  return root;
}

describe("resolveWorkspaceTemplateDir", () => {
  afterEach(async () => {
    resetWorkspaceTemplateDirCache();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("resolves templates from package root when module url is dist-rooted", async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const templatesDir = path.join(root, "docs", "reference", "templates");
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.writeFile(path.join(templatesDir, "AGENTS.md"), "# ok\n");

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "model-selection.mjs")).toString();

    const resolved = await resolveWorkspaceTemplateDir({ cwd: distDir, moduleUrl });
    expect(resolved).toBe(templatesDir);
  });

  it("falls back to package-root docs path when templates directory is missing", async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    const moduleUrl = pathToFileURL(path.join(distDir, "model-selection.mjs")).toString();

    const resolved = await resolveWorkspaceTemplateDir({ cwd: distDir, moduleUrl });
    expect(path.normalize(resolved)).toBe(path.resolve("docs", "reference", "templates"));
  });

  it("resolves templates from the dist-mirror layout when no openclaw package.json is found", async () => {
    // Simulates running from inside ~/.openclaw/plugin-runtime-deps/openclaw-*/dist/
    // where there is no openclaw package.json (the install-root one is named
    // openclaw-runtime-deps-install) and templates are mirrored alongside dist/.
    const root = await makeTempRoot();
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw-runtime-deps-install" }),
    );

    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });

    const mirroredTemplates = path.join(distDir, "docs", "reference", "templates");
    await fs.mkdir(mirroredTemplates, { recursive: true });
    await fs.writeFile(path.join(mirroredTemplates, "AGENTS.md"), "# ok\n");

    const moduleUrl = pathToFileURL(path.join(distDir, "subsystem-FimULsAo.js")).toString();
    const unrelatedCwd = await makeTempRoot();
    // Pin argv1 to the temp tree too so resolveOpenClawPackageRoot doesn't
    // walk out to the host's real openclaw checkout while running this test.
    const argv1 = path.join(unrelatedCwd, "fake-bin");

    const resolved = await resolveWorkspaceTemplateDir({ cwd: unrelatedCwd, argv1, moduleUrl });
    expect(resolved).toBe(mirroredTemplates);
  });
});
