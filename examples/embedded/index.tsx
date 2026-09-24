"use client";

import { ConnectedGameHost, type ConnectedGameHostProps } from "@rarefriends/friendsdk/runtime";
import { parseChanceGame } from "@rarefriends/friendsdk/game";
import definition from "../fishing/game.json" with { type: "json" };
import "@rarefriends/friendsdk/frame.css";
import "@rarefriends/friendsdk/runtime.css";

const fishing = parseChanceGame(definition);
export type EmbeddedFishingPreviewProps = Omit<ConnectedGameHostProps, "definition">;

export function EmbeddedFishingPreview(props: EmbeddedFishingPreviewProps) {
  return <ConnectedGameHost {...props} definition={fishing} />;
}
