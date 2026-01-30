import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BrowserManager } from './browser.js';
import { parseCommand, serializeResponse, errorResponse } from './protocol.js';
import { executeCommand } from './actions.js';
import { StreamServer } from './stream-server.js';

// Platform detection
const isWindows = process.platform === 'win32';

// =============================================================================
// LOGGING - Write to file since stdout/stderr are redirected to null
// =============================================================================
let logStream: fs.WriteStream | null = null;

function initLogging(): void {
  const logDir = getSocketDir();
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, 'daemon.log');
    // Rotate log if over 1MB
    if (fs.existsSync(logFile)) {
      const stats = fs.statSync(logFile);
      if (stats.size > 1024 * 1024) {
        const oldLog = path.join(logDir, 'daemon.old.log');
        if (fs.existsSync(oldLog)) fs.unlinkSync(oldLog);
        fs.renameSync(logFile, oldLog);
      }
    }
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
  } catch {
    // Can't log, continue without
  }
}

function log(level: 'INFO' | 'WARN' | 'ERROR', ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const line = `[${timestamp}] [${level}] ${message}\n`;
  if (logStream) {
    logStream.write(line);
  }
  // Also write to stderr for non-detached mode debugging
  if (level === 'ERROR') {
    process.stderr.write(line);
  }
}

// Session support - each session gets its own socket/pid
let currentSession = process.env.AGENT_BROWSER_SESSION || 'default';

// Stream server for browser preview
let streamServer: StreamServer | null = null;

// Default stream port (can be overridden with AGENT_BROWSER_STREAM_PORT)
const DEFAULT_STREAM_PORT = 9223;

/**
 * Set the current session
 */
export function setSession(session: string): void {
  currentSession = session;
}

/**
 * Get the current session
 */
export function getSession(): string {
  return currentSession;
}

/**
 * Get port number for TCP mode (Windows)
 * Uses a hash of the session name to get a consistent port
 */
function getPortForSession(session: string): number {
  let hash = 0;
  for (let i = 0; i < session.length; i++) {
    hash = (hash << 5) - hash + session.charCodeAt(i);
    hash |= 0;
  }
  // Port range 49152-65535 (dynamic/private ports)
  return 49152 + (Math.abs(hash) % 16383);
}

/**
 * Get the base directory for socket/pid files.
 * Priority: AGENT_BROWSER_SOCKET_DIR > XDG_RUNTIME_DIR > ~/.agent-browser > tmpdir
 */
export function getAppDir(): string {
  // 1. XDG_RUNTIME_DIR (Linux standard)
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'agent-browser');
  }

  // 2. Home directory fallback (like Docker Desktop's ~/.docker/run/)
  const homeDir = os.homedir();
  if (homeDir) {
    return path.join(homeDir, '.agent-browser');
  }

  // 3. Last resort: temp dir
  return path.join(os.tmpdir(), 'agent-browser');
}

export function getSocketDir(): string {
  // Allow explicit override for socket directory
  if (process.env.AGENT_BROWSER_SOCKET_DIR) {
    return process.env.AGENT_BROWSER_SOCKET_DIR;
  }
  return getAppDir();
}

/**
 * Get the socket path for the current session (Unix) or port (Windows)
 */
export function getSocketPath(session?: string): string {
  const sess = session ?? currentSession;
  if (isWindows) {
    return String(getPortForSession(sess));
  }
  return path.join(getSocketDir(), `${sess}.sock`);
}

/**
 * Get the port file path for Windows (stores the port number)
 */
export function getPortFile(session?: string): string {
  const sess = session ?? currentSession;
  return path.join(getSocketDir(), `${sess}.port`);
}

/**
 * Get the PID file path for the current session
 */
export function getPidFile(session?: string): string {
  const sess = session ?? currentSession;
  return path.join(getSocketDir(), `${sess}.pid`);
}

/**
 * Check if daemon is running for the current session
 */
export function isDaemonRunning(session?: string): boolean {
  const pidFile = getPidFile(session);
  if (!fs.existsSync(pidFile)) return false;

  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    // Check if process exists (works on both Unix and Windows)
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist, clean up stale files
    cleanupSocket(session);
    return false;
  }
}

/**
 * Get connection info for the current session
 * Returns { type: 'unix', path: string } or { type: 'tcp', port: number }
 */
export function getConnectionInfo(
  session?: string
): { type: 'unix'; path: string } | { type: 'tcp'; port: number } {
  const sess = session ?? currentSession;
  if (isWindows) {
    return { type: 'tcp', port: getPortForSession(sess) };
  }
  return { type: 'unix', path: path.join(getSocketDir(), `${sess}.sock`) };
}

/**
 * Clean up socket and PID file for the current session
 */
export function cleanupSocket(session?: string): void {
  const pidFile = getPidFile(session);
  const streamPortFile = getStreamPortFile(session);
  try {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    if (fs.existsSync(streamPortFile)) fs.unlinkSync(streamPortFile);
    if (isWindows) {
      const portFile = getPortFile(session);
      if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
    } else {
      const socketPath = getSocketPath(session);
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Get the stream port file path
 */
export function getStreamPortFile(session?: string): string {
  const sess = session ?? currentSession;
  return path.join(getSocketDir(), `${sess}.stream`);
}

/**
 * Start the daemon server
 * @param options.streamPort Port for WebSocket stream server (0 to disable)
 */
export async function startDaemon(options?: { streamPort?: number }): Promise<void> {
  // Initialize logging first
  initLogging();
  log('INFO', '=== Daemon starting ===');
  log('INFO', 'Session:', currentSession);
  log('INFO', 'Platform:', process.platform);
  log('INFO', 'Node version:', process.version);
  log('INFO', 'PID:', process.pid);

  // Ensure socket directory exists
  const socketDir = getSocketDir();
  log('INFO', 'Socket directory:', socketDir);
  if (!fs.existsSync(socketDir)) {
    log('INFO', 'Creating socket directory...');
    fs.mkdirSync(socketDir, { recursive: true });
  }

  // Clean up any stale socket
  log('INFO', 'Cleaning up stale sockets...');
  cleanupSocket();

  log('INFO', 'Creating browser manager...');
  const browser = new BrowserManager();
  let shuttingDown = false;
  log('INFO', 'Browser manager created');

  // Start stream server if port is specified (or use default if env var is set)
  const streamPort =
    options?.streamPort ??
    (process.env.AGENT_BROWSER_STREAM_PORT
      ? parseInt(process.env.AGENT_BROWSER_STREAM_PORT, 10)
      : 0);

  if (streamPort > 0) {
    log('INFO', `Starting stream server on port ${streamPort}...`);
    try {
      streamServer = new StreamServer(browser, streamPort);
      await streamServer.start();
      // Write stream port to file for clients to discover
      const streamPortFile = getStreamPortFile();
      fs.writeFileSync(streamPortFile, streamPort.toString());
      log('INFO', 'Stream server started successfully');
    } catch (err) {
      log('ERROR', 'Failed to start stream server:', err);
      // Continue without stream server
    }
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    let httpChecked = false;
    const clientId = Math.random().toString(36).substring(7);
    log('INFO', `Client connected: ${clientId}`);

    socket.on('data', async (data) => {
      buffer += data.toString();

      // Security: Detect and reject HTTP requests to prevent cross-origin attacks.
      // Browsers using fetch() must send HTTP headers (e.g., "POST / HTTP/1.1"),
      // while legitimate clients send raw JSON starting with "{".
      if (!httpChecked) {
        httpChecked = true;
        const trimmed = buffer.trimStart();
        if (/^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE)\s/i.test(trimmed)) {
          socket.destroy();
          return;
        }
      }

      // Process complete lines
      while (buffer.includes('\n')) {
        const newlineIdx = buffer.indexOf('\n');
        const line = buffer.substring(0, newlineIdx);
        buffer = buffer.substring(newlineIdx + 1);

        if (!line.trim()) continue;

        try {
          const parseResult = parseCommand(line);

          if (!parseResult.success) {
            const resp = errorResponse(parseResult.id ?? 'unknown', parseResult.error);
            socket.write(serializeResponse(resp) + '\n');
            continue;
          }

          // Auto-launch browser if not already launched and this isn't a launch command
          if (
            !browser.isLaunched() &&
            parseResult.command.action !== 'launch' &&
            parseResult.command.action !== 'close'
          ) {
            log('INFO', 'Auto-launching browser...');
            const extensions = process.env.AGENT_BROWSER_EXTENSIONS
              ? process.env.AGENT_BROWSER_EXTENSIONS.split(',')
                  .map((p) => p.trim())
                  .filter(Boolean)
              : undefined;

            // Parse args from env (comma or newline separated)
            const argsEnv = process.env.AGENT_BROWSER_ARGS;
            const args = argsEnv
              ? argsEnv
                  .split(/[,\n]/)
                  .map((a) => a.trim())
                  .filter((a) => a.length > 0)
              : undefined;

            // Parse proxy from env
            const proxyServer = process.env.AGENT_BROWSER_PROXY;
            const proxyBypass = process.env.AGENT_BROWSER_PROXY_BYPASS;
            const proxy = proxyServer
              ? {
                  server: proxyServer,
                  ...(proxyBypass && { bypass: proxyBypass }),
                }
              : undefined;

            const ignoreHTTPSErrors = process.env.AGENT_BROWSER_IGNORE_HTTPS_ERRORS === '1';
            try {
              await browser.launch({
                id: 'auto',
                action: 'launch' as const,
                headless: process.env.AGENT_BROWSER_HEADED !== '1',
                executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH,
                extensions: extensions,
                profile: process.env.AGENT_BROWSER_PROFILE,
                storageState: process.env.AGENT_BROWSER_STATE,
                args,
                userAgent: process.env.AGENT_BROWSER_USER_AGENT,
                proxy,
                ignoreHTTPSErrors: ignoreHTTPSErrors,
              });
              log('INFO', 'Browser auto-launched successfully');
            } catch (err) {
              log('ERROR', 'Browser auto-launch failed:', err);
              throw err;
            }
          }

          // Handle close command specially
          if (parseResult.command.action === 'close') {
            const response = await executeCommand(parseResult.command, browser);
            socket.write(serializeResponse(response) + '\n');

            if (!shuttingDown) {
              shuttingDown = true;
              setTimeout(() => {
                server.close();
                cleanupSocket();
                process.exit(0);
              }, 100);
            }
            return;
          }

          const response = await executeCommand(parseResult.command, browser);
          socket.write(serializeResponse(response) + '\n');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          socket.write(serializeResponse(errorResponse('error', message)) + '\n');
        }
      }
    });

    socket.on('error', () => {
      // Client disconnected, ignore
    });
  });

  const pidFile = getPidFile();

  // Bind to socket/port FIRST, then write PID file (fixes race condition)
  await new Promise<void>((resolve, reject) => {
    if (isWindows) {
      // Windows: use TCP socket on localhost
      const basePort = getPortForSession(currentSession);
      const portFile = getPortFile();

      // Try up to 5 ports if the primary one is in use
      const tryPort = (port: number, attempt: number): void => {
        log('INFO', `Attempting to bind to port ${port} (attempt ${attempt + 1}/5)...`);

        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && attempt < 4) {
            log('WARN', `Port ${port} in use, trying next port...`);
            tryPort(port + 1, attempt + 1);
          } else {
            log('ERROR', 'Server bind error:', err.message);
            cleanupSocket();
            reject(err);
          }
        });

        server.listen(port, '127.0.0.1', () => {
          const actualPort = (server.address() as net.AddressInfo).port;
          log('INFO', `Daemon listening on TCP port ${actualPort}`);
          fs.writeFileSync(portFile, actualPort.toString());
          // Write PID file AFTER successful bind
          fs.writeFileSync(pidFile, process.pid.toString());
          log('INFO', 'PID file written:', pidFile);
          resolve();
        });
      };

      tryPort(basePort, 0);
    } else {
      // Unix: use Unix domain socket
      const socketPath = getSocketPath();
      log('INFO', `Attempting to bind to socket ${socketPath}...`);

      server.once('error', (err: NodeJS.ErrnoException) => {
        log('ERROR', 'Server bind error:', err.message);
        cleanupSocket();
        reject(err);
      });

      server.listen(socketPath, () => {
        log('INFO', `Daemon listening on Unix socket ${socketPath}`);
        // Write PID file AFTER successful bind
        fs.writeFileSync(pidFile, process.pid.toString());
        log('INFO', 'PID file written:', pidFile);
        resolve();
      });
    }
  });

  // Add general error handler for runtime errors (after initial bind)
  server.on('error', (err) => {
    log('ERROR', 'Server runtime error:', err);
    cleanupSocket();
    process.exit(1);
  });

  // Handle shutdown signals
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Stop stream server if running
    if (streamServer) {
      await streamServer.stop();
      streamServer = null;
      // Clean up stream port file
      const streamPortFile = getStreamPortFile();
      try {
        if (fs.existsSync(streamPortFile)) fs.unlinkSync(streamPortFile);
      } catch {
        // Ignore cleanup errors
      }
    }

    await browser.close();
    server.close();
    cleanupSocket();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  // Handle unexpected errors - always cleanup
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    cleanupSocket();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    cleanupSocket();
    process.exit(1);
  });

  // Cleanup on normal exit
  process.on('exit', () => {
    cleanupSocket();
  });

  // Keep process alive
  process.stdin.resume();
}

// Run daemon if this is the entry point
if (process.argv[1]?.endsWith('daemon.js') || process.env.AGENT_BROWSER_DAEMON === '1') {
  startDaemon().catch((err) => {
    console.error('Daemon error:', err);
    cleanupSocket();
    process.exit(1);
  });
}
