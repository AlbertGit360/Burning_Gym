// Isolated browser test fixture. Applications import index.tsx instead.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { GenerationIdentityClient } from "@rarefriends/friendsdk/identity";
import { type EmbeddedFishingPreviewProps } from "./index.js";
import { ConnectedGameHost } from "@rarefriends/friendsdk/runtime";
import { parseChanceGame } from "@rarefriends/friendsdk/game";
import gameJson from "../fishing/game.json" with { type: "json" };
import "@rarefriends/friendsdk/frame.css";
import "@rarefriends/friendsdk/runtime.css";

type FixtureContext = Omit<EmbeddedFishingPreviewProps, "publicClient"> & { definitionName?: string; identity: "eligible" | "unowned" | "unhardwired" | "error" | "loading" };
const initial: FixtureContext = {
  selectedFriend: { id: 7730n, label: "Host sample Friend A", kind: "sample" },
  account: "0x0000000000000000000000000000000000000001", chainId: 4663,
  frameUrl: "/embed/fishing-frame.html",
  identity: "eligible",
};
function Fixture() {
  const [context, setContext] = useState(initial);
  useEffect(() => {
    const update = (event: Event) => setContext(value => ({ ...value, ...(event as CustomEvent<Partial<FixtureContext>>).detail }));
    window.addEventListener("friendsdk:test-context", update);
    return () => window.removeEventListener("friendsdk:test-context", update);
  }, []);
  // Automated-test data only. Never export this mock as a prototype ownership bypass.
  const publicClient = useMemo(() => ({
    getChainId: async () => context.chainId ?? 4663,
    getBlockNumber: async () => {
      if (context.identity === "loading") return new Promise<bigint>(() => {});
      if (context.identity === "error") throw new Error("Fixture RPC unavailable.");
      return 1n;
    },
    readContract: async ({ functionName }: { functionName: string }) => functionName === "generation"
      ? context.identity === "unhardwired" ? 0 : 1
      : context.identity === "unowned" ? "0x0000000000000000000000000000000000000099" : context.account,
  }) as GenerationIdentityClient, [context.account, context.chainId, context.identity]);
  const definition = useMemo(() => parseChanceGame({ ...gameJson, name: context.definitionName ?? gameJson.name }), [context.definitionName]);
  return <ConnectedGameHost {...context} definition={definition} publicClient={publicClient} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
