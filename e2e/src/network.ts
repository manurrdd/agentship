import dns, { promises as dnsPromises } from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

/**
 * A recorder for everything this process tries to reach on the network.
 *
 * There is no proxy to configure and nothing to trust: every outbound TCP connection in
 * Node goes through `net.Socket#connect` or `tls.connect`, and every hostname has to be
 * resolved first. Patching those four entry points catches `fetch`, `http`, `https`,
 * `undici` and anything a dependency might do behind our back — and it catches the attempt
 * even when the connection would have failed.
 *
 * The recorder does not block: a destination that appears is reported, not prevented, so
 * the test can say exactly what was contacted.
 */
export interface Destination {
  readonly host: string;
  readonly port?: number;
  readonly via: 'tcp' | 'tls' | 'dns';
}

export interface NetworkRecording {
  readonly destinations: readonly Destination[];
  readonly hosts: readonly string[];
  stop(): void;
}

type ConnectArgs = readonly unknown[];

function hostOf(args: ConnectArgs): { host: string; port?: number } | undefined {
  const [first, second] = args;
  // `net.connect(port, host, cb)` reaches `Socket#connect` as a pre-normalized
  // `[options, callback]` array, so the real arguments are one level in.
  if (Array.isArray(first)) return hostOf(first as ConnectArgs);
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: string; hostname?: string; port?: number; path?: string };
    // A unix socket has a path and no host: it is not the network.
    if (options.path !== undefined && options.host === undefined) return undefined;
    const host = options.host ?? options.hostname ?? 'localhost';
    return options.port === undefined ? { host } : { host, port: options.port };
  }
  if (typeof first === 'number') {
    return { host: typeof second === 'string' ? second : 'localhost', port: first };
  }
  // `connect('/tmp/socket')` — a pipe, not a destination.
  return undefined;
}

export function recordNetwork(): NetworkRecording {
  const destinations: Destination[] = [];
  const add = (via: Destination['via'], target: { host: string; port?: number } | undefined) => {
    if (target === undefined) return;
    destinations.push({
      via,
      host: target.host,
      ...(target.port === undefined ? {} : { port: target.port }),
    });
  };

  const socketConnect = net.Socket.prototype.connect;
  const tlsConnect = tls.connect;
  const lookup = dns.lookup;
  const lookupPromise = dnsPromises.lookup;

  // biome-ignore lint/suspicious/noExplicitAny: patching Node's own overloaded signatures.
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    add('tcp', hostOf(args));
    return socketConnect.apply(this, args as Parameters<typeof socketConnect>);
  } as typeof socketConnect;

  // biome-ignore lint/suspicious/noExplicitAny: same.
  (tls as { connect: unknown }).connect = (...args: any[]) => {
    add('tls', hostOf(args));
    return (tlsConnect as (...a: unknown[]) => unknown)(...args);
  };

  // biome-ignore lint/suspicious/noExplicitAny: same.
  (dns as { lookup: unknown }).lookup = (...args: any[]) => {
    add('dns', typeof args[0] === 'string' ? { host: args[0] } : undefined);
    return (lookup as (...a: unknown[]) => unknown)(...args);
  };

  // biome-ignore lint/suspicious/noExplicitAny: same.
  (dnsPromises as { lookup: unknown }).lookup = (...args: any[]) => {
    add('dns', typeof args[0] === 'string' ? { host: args[0] } : undefined);
    return (lookupPromise as (...a: unknown[]) => unknown)(...args);
  };

  return {
    get destinations() {
      return destinations;
    },
    get hosts() {
      return [...new Set(destinations.map((destination) => destination.host))].sort();
    },
    stop() {
      net.Socket.prototype.connect = socketConnect;
      (tls as { connect: unknown }).connect = tlsConnect;
      (dns as { lookup: unknown }).lookup = lookup;
      (dnsPromises as { lookup: unknown }).lookup = lookupPromise;
    },
  };
}

/** Loopback is the test's own plumbing, never a destination Agentship chose. */
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
