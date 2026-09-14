import type { BaDbConnectionResolved } from "../../workspace/baStore.js";
import { withSshTunnel } from "../sshTunnel/tunnel.js";

/**
 * If cfg.ssh is enabled, open a local-forward then call `fn` with host/port
 * remapped to 127.0.0.1:tunnelLocalPort. Otherwise call `fn(cfg)` directly.
 */
export async function withBaDbResolvedConnection<T>(
  cfg: BaDbConnectionResolved,
  fn: (connectCfg: BaDbConnectionResolved) => Promise<T>,
): Promise<T> {
  const ssh = cfg.ssh;
  if (!ssh?.enabled || !ssh.sshHost) {
    return fn(cfg);
  }
  if (!ssh.sshUsername) {
    throw new Error("SSH username required for tunnel");
  }
  if (!ssh.sshPassword && !ssh.sshPrivateKey) {
    throw new Error("SSH password or private key required for tunnel");
  }
  return withSshTunnel(
    {
      sshHost: ssh.sshHost,
      sshPort: ssh.sshPort || 22,
      sshUsername: ssh.sshUsername,
      sshPassword: ssh.sshPassword || "",
      sshPrivateKey: ssh.sshPrivateKey || "",
      tunnelLocalPort: ssh.tunnelLocalPort,
      remoteHost: cfg.host,
      remotePort: cfg.port,
      label: "create-data",
    },
    async (local) =>
      fn({
        ...cfg,
        host: local.host,
        port: local.port,
        ssh: null,
      }),
  );
}
