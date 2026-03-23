// Preload module: wraps process.on('unhandledRejection') handlers to
// suppress tinypool's ERR_IPC_CHANNEL_CLOSED teardown race.  Vitest's own
// handler unconditionally calls process.exit(1) for any unhandled rejection,
// and its dangerouslyIgnoreUnhandledErrors only covers errors collected during
// test execution.  This preload intercepts the event before vitest sees it.
const origOn = process.on.bind(process);
process.on = function (event, handler) {
  if (event === "unhandledRejection") {
    return origOn(event, (reason, promise) => {
      if (reason && reason.code === "ERR_IPC_CHANNEL_CLOSED") return;
      return handler(reason, promise);
    });
  }
  return origOn(event, handler);
};
