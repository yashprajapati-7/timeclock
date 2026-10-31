// Stop accepting requests, close the database, exit. If a request hangs, force the exit after timeoutMs.
// Repeated signals (Ctrl+C twice) are ignored.
export const gracefulShutdown = ({ server, db, exit = process.exit, timeoutMs = 10000 }) => {
  let closing = false;
  return () => {
    if(closing) return;
    closing = true;
    setTimeout(() => exit(1), timeoutMs).unref();
    server.close(() => { db.close(); exit(0); });
  };
};
