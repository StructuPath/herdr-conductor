import { writeFileSync, mkdirSync, readdirSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { createHarnessControlPlane } from "../../scripts/harness-teardown.mjs";

const [parent, resultPath, killAt] = process.argv.slice(2);
const plane = await createHarnessControlPlane({ parent });
const nested = join(plane.rootPath, "repositories", "repo");
mkdirSync(nested, { mode: 0o555 });
await plane.appendManifestRecord(relative(plane.rootPath, nested));
const identities = {};
function inventory(path, relativePath = ".") {
	const stats = lstatSync(path);
	identities[relativePath] = {
		device: String(stats.dev),
		inode: String(stats.ino),
		type: stats.isDirectory() ? "directory" : "file",
	};
	if (stats.isDirectory())
		for (const name of readdirSync(path))
			inventory(
				join(path, name),
				relativePath === "." ? name : `${relativePath}/${name}`,
			);
}
inventory(plane.rootPath);
writeFileSync(resultPath, JSON.stringify({ root: plane.rootPath, identities }));
await plane.sealHarnessManifest();
await plane.teardownHarness({ killAt });
