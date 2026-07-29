import {
	acquireRepositoryLock,
	openRepositoryStore,
	releaseRepositoryLock,
} from "../../scripts/state-kernel.mjs";

const [stateRoot, repoPath, operationId] = process.argv.slice(2);
try {
	const store = openRepositoryStore({ stateRoot, repoPath });
	const lock = acquireRepositoryLock(store, { operationId });
	process.stdout.write("winner\n");
	await new Promise((resolve) => setTimeout(resolve, 750));
	releaseRepositoryLock(lock);
} catch (error) {
	if (error?.code === "lock_busy" || error?.code === "lock_unknown") {
		process.stdout.write(`${error.code}\n`);
	} else {
		console.error(error);
		process.exitCode = 1;
	}
}
