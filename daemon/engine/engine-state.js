// Shared, mutable daemon-engine state. Property mutation on this single object
// reference propagates across modules (same pattern as runtime.js `timers`), so
// the engine facade and its cycle submodules can all read/write the busy flags
// and cron-task registry without a circular import or read-only live-binding
// problem. Keep this a plain data bag — no logic, no imports.
export const engineState = {
  cronTasks: [],            // active cron tasks + interval refs (stopCronJobs clears these)
  cronStarted: false,       // guards against a double startCronJobs()
  managementBusy: false,    // prevents overlapping management cycles
  managementBusyReason: null, // label of whatever last set managementBusy=true (watchdog reports it on a stuck force-reset)
  screeningBusy: false,     // prevents overlapping screening cycles
  screeningLastTriggered: 0, // epoch ms — prevents management from spamming screening
};
