import type { Server } from 'node:http';

export function buildGame(gameDirectory: string, options?: {
  outdir?: string; watch?: boolean;
  /** Public deployment configuration. Omit for simulated gameplay. */
  deployment?: unknown;
}): Promise<{ outdir: string; close(): Promise<void> }>;

/** Returns a Node server; call listen() to start and close() to stop it. */
export function createGameServer(outdir: string): Server;

export function readGameDeployment(input: unknown): Promise<Readonly<{
  chainId: number; game: string; rf: string; generations: string; entropy: string; provider: string; deploymentBlock: string;
}>>;
