/**
 * Entry point of the Render Workflows service (see render.yaml). Render
 * starts one process per task run, and once per deploy to register the
 * tasks; either way it calls this file:
 *
 *   npm run workflows                            # what Render runs
 *   render workflows dev -- npm run workflows    # local task server on :8120
 *
 * The SDK would start its task server on its own as soon as the first task is
 * defined. It is started here instead, after every task is registered, so the
 * process can exit when the run is done: the database pool would otherwise
 * keep it, and its billed instance, alive until the task's timeout.
 */
process.env.RENDER_SDK_AUTO_START = "false";

await import("./tasks");
const { startTaskServer } = await import("@renderinc/sdk/workflows");

if (!process.env.RENDER_SDK_SOCKET_PATH) {
  console.error("Start this with Render (a workflow service) or `render workflows dev -- npm run workflows`.");
  process.exit(1);
}

try {
  await startTaskServer();
  process.exit(0);
} catch (err) {
  // The SDK has already reported the failure to Render, which retries the run per the task's settings.
  console.error(err);
  process.exit(1);
}

export {};
