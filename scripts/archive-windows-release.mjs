import { access, mkdir, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(projectRoot, "release");
const legacyDir = path.join(releaseDir, "legacy");
const packageJson = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);

const { version, build = {} } = packageJson;
const productName = build.productName ?? packageJson.name;
const installerPrefix = `${productName} Setup `;
const currentInstaller = `${installerPrefix}${version}.exe`;
const currentArtifacts = new Set([currentInstaller, `${currentInstaller}.blockmap`]);

let entries;
try {
  entries = await readdir(releaseDir, { withFileTypes: true });
} catch (error) {
  if (error.code === "ENOENT") {
    console.log("No release directory yet; nothing to archive.");
    process.exit(0);
  }
  throw error;
}

const previousArtifacts = entries
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter(
    (name) =>
      name.startsWith(installerPrefix) &&
      (name.endsWith(".exe") || name.endsWith(".exe.blockmap")) &&
      !currentArtifacts.has(name),
  );

if (previousArtifacts.length === 0) {
  console.log("No previous Windows installer artifacts to archive.");
  process.exit(0);
}

await mkdir(legacyDir, { recursive: true });

for (const name of previousArtifacts) {
  const source = path.join(releaseDir, name);
  const destination = path.join(legacyDir, name);

  try {
    await access(destination);
    throw new Error(`Archive destination already exists: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await rename(source, destination);
  console.log(`Archived ${name}`);
}
