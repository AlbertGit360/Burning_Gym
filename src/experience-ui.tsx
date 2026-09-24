"use client";

import { useId, useState, type CSSProperties, type ReactNode } from "react";
import type { GameItem, GameItemQuantities, GameReward, GameShopOffer } from "./items.js";
import { formatGameItemQuantity } from "./items.js";
import { RewardReveal, type RewardRevealCompletion, type RewardRevealPhase, type RewardRevealProps } from "./reward-reveal.js";

export type GameStyle = CSSProperties & Partial<Record<`--game-${string}`, string | number>>;
export type GameCurrency = Readonly<{ symbol: string; decimals: number }>;
export type ExperiencePanelStage = "activity" | "review" | "pending" | "working" | "reward" | "shop";
export type ExperienceDataAttributes = Partial<Record<`data-${string}`, string | number | boolean>>;
const DEFAULT_CURRENCY: GameCurrency = { symbol: "", decimals: 0 };
/** Every choice is visible at once. Larger menus must be split into separate activities or shops. */
export const GAME_VISIBLE_CHOICES = 6;

/** Exact base-unit formatting. Balances and prices never pass through Number. */
export function formatGameAmount(value: bigint, decimals = 0): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError("Currency decimals must be an integer from 0 to 255");
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const integer = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}

export function Keycap({ children }: { children: ReactNode }) { return <kbd className="rf-game-keycap">{children}</kbd>; }

export function ItemArt({ item, className = "" }: { item: GameItem; className?: string }) {
  const rows = item.art?.rows ?? [];
  const width = rows.length ? Math.max(1, ...rows.map(row => row.length)) : 16;
  const height = rows.length || 16;
  const path = rows.flatMap((row, y) => [...row].flatMap((pixel, x) => pixel === "#" ? [`M${x} ${y}h1v1h-1z`] : [])).join("");
  return <svg className={`rf-game-item-art ${className}`.trim()} viewBox={`0 0 ${width} ${height}`} fill="currentColor" shapeRendering="crispEdges" role="img" aria-label={item.name}><path d={path || "M8 1 15 8 8 15 1 8Z"} /></svg>;
}

function InventoryIcon() {
  return <svg className="rf-game-inventory-icon" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2" shapeRendering="crispEdges" aria-hidden="true"><path d="M5 8h22v20H5zM10 8V4h12v4M5 14h22M13 14v5h6v-5" /></svg>;
}
function ProgressArt() { return <div className="rf-game-loading-mark" aria-hidden="true"><i /><i /><i /><i /></div>; }

export type ItemPickerProps = {
  items: readonly GameItem[];
  counts?: GameItemQuantities;
  selectedItemId?: string | null;
  onSelectItem?: (itemId: string) => void;
  label?: string;
  itemArt?: (item: GameItem) => ReactNode;
  /** @deprecated All choices are displayed together; retained for source compatibility. */
  previousLabel?: string;
  /** @deprecated All choices are displayed together; retained for source compatibility. */
  nextLabel?: string;
};

/** All item artwork and quantities stay visible. Unowned items cannot be selected. */
export function ItemPicker({ items, counts = {}, selectedItemId, onSelectItem, label = "Choose item", itemArt }: ItemPickerProps) {
  const name = useId();
  if (items.length > GAME_VISIBLE_CHOICES) return <p className="rf-game-configuration-error" role="alert">Builder setup: show at most {GAME_VISIBLE_CHOICES} item choices per activity.</p>;
  return <div className="rf-game-item-picker" data-count={items.length} data-rows={items.length > 3 ? 2 : 1}>
    <div className="rf-game-item-choices" role="radiogroup" aria-label={label}>{items.map(item => {
      const count = counts[item.id] ?? 0n;
      const accessibleName = `${item.name}, ${formatGameItemQuantity(item, count)} owned`;
      return <label className="rf-game-item-choice" key={item.id} data-item-id={item.id} data-selected={item.id === selectedItemId} data-stock={count > 0n} title={accessibleName}><input type="radio" name={name} checked={item.id === selectedItemId} onChange={() => onSelectItem?.(item.id)} disabled={!onSelectItem || count <= 0n} aria-label={accessibleName} /><span className="rf-game-choice-art rf-game-art-slot" aria-hidden="true">{itemArt?.(item) ?? <ItemArt item={item} />}</span><span className="rf-game-choice-name">{item.name}</span><small>{formatGameItemQuantity(item, count)} owned</small></label>;
    })}</div>
  </div>;
}

export type ExperienceLabels = {
  activityLocation: string; shopLocation: string; rewardLocation: string; activityTitle: string; activityDescription: string;
  action: string; selectItem: string; reviewTitle: string; reviewDescription: string; confirm: string; cancel: string;
  pendingTitle: string; pendingDescription: string; workingTitle: string; readyTitle: string; workingDescription: string; readyDescription: string;
  resolve: string; waiting: string; rewardTitle: string; keep: string; openShop: string; emptyInventory: string; emptyShop: string;
  buy: string; sell: string; returnToActivity: string; close: string; balance: string; item: string; total: string; value: string;
  reviewNotice: string; insufficientBalance: string; missingItems: string; buyTab: string; sellTab: string;
  activityCost: string; anticipationTitle: string; emergenceTitle: string; reveal: string;
  previousOffer: string; nextOffer: string; previousInventory: string; nextInventory: string; previousChoices: string; nextChoices: string;
};

const DEFAULT_LABELS: ExperienceLabels = {
  activityLocation: "Activity", shopLocation: "Shop", rewardLocation: "Reward", activityTitle: "Choose an item", activityDescription: "",
  action: "Start", selectItem: "Choose item", reviewTitle: "Review purchase", reviewDescription: "", confirm: "Confirm", cancel: "Cancel",
  pendingTitle: "Confirming", pendingDescription: "", workingTitle: "In progress", readyTitle: "Ready", workingDescription: "", readyDescription: "",
  resolve: "Finish", waiting: "Waiting", rewardTitle: "Your reward", keep: "Keep item", openShop: "Visit shop", emptyInventory: "No items yet.", emptyShop: "No offers available.",
  buy: "Buy", sell: "Sell", returnToActivity: "Back", close: "Close panel", balance: "Balance", item: "Item", total: "Total", value: "Value",
  reviewNotice: "", insufficientBalance: "Insufficient balance.", missingItems: "Get the required items from the shop.", buyTab: "Buy", sellTab: "Sell",
  activityCost: "Required", anticipationTitle: "Preparing reward", emergenceTitle: "Reward appearing", reveal: "Reveal reward",
  previousOffer: "Previous offer", nextOffer: "Next offer", previousInventory: "Previous item", nextInventory: "Next item", previousChoices: "Previous items", nextChoices: "Next items",
};

export type ExperiencePanelProps = {
  stage: ExperiencePanelStage;
  itemCatalog: readonly GameItem[];
  itemCounts?: GameItemQuantities;
  selectableItemIds?: readonly string[];
  selectedItemId?: string | null;
  activeItemId?: string | null;
  /** Zero permits an activity without selecting or consuming an item. */
  itemCost?: bigint;
  /** Fixed requirements, added to any selected-item cost before checking stock. */
  requirements?: GameItemQuantities;
  balance: bigint;
  currency?: GameCurrency;
  shopOffers?: readonly GameShopOffer[];
  sellOffers?: readonly GameShopOffer[];
  purchase?: GameShopOffer | null;
  inventory?: readonly GameReward[];
  reward?: GameReward | null;
  rewardValue?: bigint;
  /** The host may block purchases independently of activity item ownership. */
  purchaseDisabled?: boolean;
  shopTab?: "buy" | "sell";
  pendingStep?: number;
  pendingSteps?: readonly string[];
  status?: string;
  error?: string;
  workingReady?: boolean;
  revealKey?: string | number;
  reducedMotion?: boolean;
  onRevealPhase?: (phase: RewardRevealPhase, item: GameItem) => void;
  onRevealComplete?: (item: GameItem, reason: RewardRevealCompletion) => void;
  onSelectItem?: (itemId: string) => void;
  onBuy?: (offerId: string) => void;
  onSell?: (inventoryId: string, offerId: string) => void;
  onSellReward?: () => void;
  /** Host redemption policy; keep collectibles visible while disabling unavailable sales. */
  canSellReward?: (reward: GameReward) => boolean;
  onAction?: () => void;
  onConfirm?: () => void;
  onResolve?: () => void;
  onKeep?: () => void;
  onShop?: () => void;
  onReturn?: () => void;
  onClose?: () => void;
  onShopTabChange?: (tab: "buy" | "sell") => void;
  labels?: Partial<ExperienceLabels>;
  slots?: {
    activityArt?: ReactNode; workingArt?: ReactNode; pendingArt?: ReactNode; emptyArt?: ReactNode;
    itemArt?: (item: GameItem) => ReactNode; headerActions?: ReactNode; footer?: ReactNode;
    reveal?: (props: RewardRevealProps) => ReactNode;
    rewardDetails?: ReactNode;
  };
  className?: string;
  style?: GameStyle;
  dataAttributes?: ExperienceDataAttributes;
};

function PanelAction({ label, accessibleLabel = label, glyph, primary = false, disabled = false, onClick }: {
  label: string; accessibleLabel?: string; glyph?: string; primary?: boolean; disabled?: boolean; onClick?: () => void;
}) {
  return <button type="button" className={`rf-game-button${primary ? " rf-game-button-primary" : ""}`} data-primary-action={primary || undefined} onClick={onClick} disabled={disabled || !onClick} aria-label={accessibleLabel} title={accessibleLabel}><span className="rf-game-button-label">{label}</span>{glyph && <span className="rf-game-button-glyph" aria-hidden="true">{glyph}</span>}</button>;
}

/** Bounded presentation. The host owns focus, permissions, balances, and settlement. */
export function ExperiencePanel({ stage, itemCatalog, itemCounts = {}, selectableItemIds, selectedItemId, activeItemId, itemCost = 0n, requirements = {}, balance, currency = DEFAULT_CURRENCY,
  shopOffers = [], sellOffers = [], purchase, inventory = [], reward, rewardValue, purchaseDisabled = false, shopTab: controlledTab, pendingStep = 0, pendingSteps = ["Request submitted", "Confirming"], status, error, workingReady = false,
  revealKey, reducedMotion, onRevealPhase, onRevealComplete, onSelectItem, onBuy, onSell, onSellReward, canSellReward, onAction, onConfirm, onResolve, onKeep, onShop, onReturn, onClose, onShopTabChange,
  labels: overrides, slots = {}, className = "", style, dataAttributes,
}: ExperiencePanelProps) {
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const [inventoryPage, setInventoryPage] = useState(0);
  const [localTab, setLocalTab] = useState<"buy" | "sell">("buy");
  const [revealState, setRevealState] = useState<{ key: string | number; phase: RewardRevealPhase } | null>(null);
  const [skipSignal, setSkipSignal] = useState(0);
  const id = useId();
  const labels = { ...DEFAULT_LABELS, ...overrides };
  const tab = controlledTab ?? localTab;
  const changeTab = (next: "buy" | "sell") => { setLocalTab(next); onShopTabChange?.(next); };
  const item = (itemId?: string | null) => itemCatalog.find(value => value.id === itemId);
  const quantity = (value: bigint, itemId?: string | null) => { const definition = item(itemId); return definition ? formatGameItemQuantity(definition, value) : formatGameAmount(value); };
  const renderArt = (value: GameItem) => slots.itemArt?.(value) ?? <ItemArt item={value} />;
  const selectedItem = item(selectedItemId), activeItem = item(activeItemId) ?? selectedItem, rewardItem = item(reward?.itemId), purchaseItem = item(purchase?.itemId);
  const choices = selectableItemIds ? selectableItemIds.flatMap(itemId => { const value = item(itemId); return value ? [value] : []; }) : itemCatalog;
  const selectedCount = selectedItem ? itemCounts[selectedItem.id] ?? 0n : 0n;
  const requiredItems: Record<string, bigint> = { ...requirements };
  if (selectedItem && itemCost > 0n) requiredItems[selectedItem.id] = (requiredItems[selectedItem.id] ?? 0n) + itemCost;
  const requiredEntries = Object.entries(requiredItems).filter(([, quantity]) => quantity > 0n);
  const missingItems = (itemCost > 0n && !selectedItem) || requiredEntries.some(([itemId, quantity]) => (itemCounts[itemId] ?? 0n) < quantity);
  const requirementText = requiredEntries.map(([itemId, count]) => `${quantity(count, itemId)} ${item(itemId)?.name ?? itemId}`).join(" + ");
  const choiceError = choices.length > GAME_VISIBLE_CHOICES ? `Builder setup: show at most ${GAME_VISIBLE_CHOICES} item choices per activity.` : "";
  const offerError = shopOffers.length > GAME_VISIBLE_CHOICES ? `Builder setup: show at most ${GAME_VISIBLE_CHOICES} offers per shop.` : shopOffers.some(value => !item(value.itemId)) ? "Builder setup: every shop offer needs an item in the catalog." : "";
  const configurationError = stage === "activity" ? choiceError : stage === "shop" && tab === "buy" ? offerError : "";
  const offer = !offerError ? shopOffers.find(value => value.id === selectedOfferId) ?? shopOffers[0] : undefined, offerItem = item(offer?.itemId);
  const inventoryIndex = Math.min(inventoryPage, Math.max(0, inventory.length - 1));
  const inventoryEntry = inventory[inventoryIndex], inventoryItem = item(inventoryEntry?.itemId);
  const sellOffer = inventoryEntry && sellOffers.find(value => value.itemId === inventoryEntry.itemId && value.quantity <= inventoryEntry.quantity);
  const canSell = Boolean(sellOffer && inventoryEntry && (itemCounts[inventoryEntry.itemId] ?? 0n) >= sellOffer.quantity && (canSellReward?.(inventoryEntry) ?? true));
  const revealPhase = revealKey === undefined || !rewardItem ? "complete" : revealState?.key === revealKey ? revealState.phase : "anticipation";
  const revealReady = revealPhase === "complete";
  const revealTitle = revealPhase === "anticipation" ? labels.anticipationTitle : revealPhase === "emergence" ? labels.emergenceTitle : labels.rewardTitle;
  const steps = pendingSteps.length ? pendingSteps : [labels.pendingTitle];
  const activeStep = Math.max(0, Math.min(steps.length - 1, Number.isFinite(pendingStep) ? Math.floor(pendingStep) : 0));
  const stepStart = Math.max(0, Math.min(activeStep - 1, steps.length - 3));
  const money = (value: bigint) => `${formatGameAmount(value, currency.decimals)}${currency.symbol ? ` ${currency.symbol}` : ""}`;
  let summaryLabel = labels.total, summaryText = money(purchase?.price ?? 0n), summaryAmount: bigint | undefined = purchase?.price ?? 0n;
  if (stage === "activity" || stage === "working") { summaryLabel = stage === "activity" ? labels.activityCost : labels.item; summaryAmount = undefined; summaryText = stage === "working" ? itemCost > 0n && activeItem ? `${quantity(itemCost, activeItem.id)} ${activeItem.name} used` : requirementText || labels.workingTitle : requirementText ? `${requirementText}${selectedItem && requiredEntries.length === 1 ? ` · ${quantity(selectedCount, selectedItem.id)} owned` : ""}` : labels.readyTitle; }
  if (stage === "reward") { summaryLabel = !revealReady ? labels.rewardLocation : rewardValue === undefined ? labels.item : labels.value; summaryAmount = revealReady ? rewardValue : undefined; summaryText = !revealReady ? revealTitle : rewardValue !== undefined ? money(rewardValue) : `${quantity(reward?.quantity ?? 0n, rewardItem?.id)} ${rewardItem?.name ?? labels.item}`; }
  if (stage === "shop") { summaryLabel = tab === "buy" && offer ? `${quantity(offer.quantity, offer.itemId)} ${offerItem?.name ?? labels.item}` : labels.balance; summaryAmount = tab === "buy" ? offer?.price ?? 0n : balance; summaryText = money(summaryAmount); }
  const feedbackError = error || configurationError;
  const feedback = feedbackError || status || (stage === "activity" && missingItems ? labels.missingItems : stage === "review" ? purchase && balance < purchase.price ? labels.insufficientBalance : labels.reviewNotice : stage === "pending" ? `${activeStep + 1} / ${steps.length} · ${steps[activeStep]}` : "");
  const location = ["shop", "review", "pending"].includes(stage) ? labels.shopLocation : stage === "reward" ? labels.rewardLocation : labels.activityLocation;
  const busy = stage === "pending" || stage === "working";
  const revealProps: RewardRevealProps | undefined = rewardItem && revealKey !== undefined ? { item: rewardItem, revealKey, reducedMotion, skipSignal, showSkipControl: false, slots: { itemArt: renderArt(rewardItem) }, onPhase: (phase, value) => { setRevealState({ key: revealKey, phase }); onRevealPhase?.(phase, value); }, onComplete: onRevealComplete } : undefined;

  return <section className={`rf-game-panel ${className}`.trim()} data-stage={stage} data-experience-stage={stage} data-shop-tab={tab} data-reveal-phase={stage === "reward" ? revealPhase : undefined} data-ready={workingReady || undefined} data-footer={slots.footer != null || undefined} data-reward-details={slots.rewardDetails != null || undefined} style={style} {...dataAttributes}>
    <div className="rf-game-panel-bar"><span title={location}>{location}</span><div className="rf-game-header-actions">{slots.headerActions}{onClose && !busy && <button type="button" className="rf-game-close" onClick={onClose} aria-label={labels.close}>×</button>}</div></div>
    {stage === "activity" && <div className="rf-game-panel-body rf-game-activity-body" data-picker={choices.length > 0 || undefined}><div className="rf-game-activity-intro">{slots.activityArt && <div className="rf-game-activity-art rf-game-art-slot">{slots.activityArt}</div>}<h2 className="rf-game-title" title={labels.activityTitle}>{labels.activityTitle}</h2><p className="rf-game-description">{labels.activityDescription}</p></div>{choices.length > 0 && <ItemPicker items={choices} counts={itemCounts} selectedItemId={selectedItemId} onSelectItem={onSelectItem} label={labels.selectItem} itemArt={renderArt} />}</div>}
    {stage === "review" && <div className="rf-game-panel-body rf-game-review-body"><h2 className="rf-game-title" title={labels.reviewTitle}>{labels.reviewTitle}</h2><p className="rf-game-description">{labels.reviewDescription}</p>{purchaseItem && <div className="rf-game-purchase-art rf-game-art-slot">{renderArt(purchaseItem)}</div>}<dl className="rf-game-receipt"><div><dt>{labels.item}</dt><dd title={`${quantity(purchase?.quantity ?? 0n, purchase?.itemId)} ${purchaseItem?.name ?? labels.item}`}>{quantity(purchase?.quantity ?? 0n, purchase?.itemId)} {purchaseItem?.name ?? labels.item}</dd></div><div><dt>{labels.balance}</dt><dd title={money(balance)}>{formatGameAmount(balance, currency.decimals)} <span>{currency.symbol}</span></dd></div></dl></div>}
    {stage === "pending" && <div className="rf-game-panel-body rf-game-pending-body"><div className="rf-game-pending-art rf-game-art-slot">{slots.pendingArt ?? <ProgressArt />}</div><h2 className="rf-game-title" title={labels.pendingTitle}>{labels.pendingTitle}</h2><p className="rf-game-description">{labels.pendingDescription}</p><ol className="rf-game-progress" start={stepStart + 1}>{steps.slice(stepStart, stepStart + 3).map((step, index) => { const originalIndex = stepStart + index; return <li key={originalIndex} data-state={originalIndex < activeStep ? "complete" : originalIndex === activeStep ? "current" : "waiting"} aria-current={originalIndex === activeStep ? "step" : undefined}><span className="rf-game-progress-mark" aria-hidden="true">{originalIndex < activeStep ? "✓" : String(originalIndex + 1).padStart(2, "0")}</span><span title={step}>{step}</span></li>; })}</ol></div>}
    {stage === "working" && <div className="rf-game-panel-body rf-game-working-body"><div className="rf-game-working-art rf-game-art-slot">{slots.workingArt ?? <ProgressArt />}</div><h2 className="rf-game-title" title={workingReady ? labels.readyTitle : labels.workingTitle}>{workingReady ? labels.readyTitle : labels.workingTitle}</h2><p className="rf-game-description">{workingReady ? labels.readyDescription : labels.workingDescription}</p></div>}
    {stage === "reward" && <div className="rf-game-panel-body rf-game-reward-body"><h2 className="rf-game-reward-title" title={revealTitle}>{revealTitle}</h2><div className="rf-game-reward-art rf-game-art-slot">{revealProps ? slots.reveal?.(revealProps) ?? <RewardReveal {...revealProps} /> : rewardItem ? renderArt(rewardItem) : <InventoryIcon />}</div><span className="rf-game-rarity" data-rarity={rewardItem?.rarity} data-reveal-hidden={!revealReady || !rewardItem?.rarity || undefined} aria-hidden={!revealReady || !rewardItem?.rarity}>{rewardItem?.rarity}</span><h3 className="rf-game-item-name" title={revealReady ? rewardItem?.name : undefined} data-reveal-hidden={!revealReady || undefined} aria-hidden={!revealReady}>{rewardItem?.name}</h3>{slots.rewardDetails != null && <div className="rf-game-reward-details" data-reveal-hidden={!revealReady || undefined} aria-hidden={!revealReady}>{slots.rewardDetails}</div>}</div>}
    {stage === "shop" && <div className="rf-game-panel-body rf-game-shop-body"><div className="rf-game-shop-tabs" role="tablist" aria-label={labels.shopLocation} onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const next = event.key === "Home" ? "buy" : event.key === "End" ? "sell" : tab === "buy" ? "sell" : "buy"; changeTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus(); }}>{(["buy", "sell"] as const).map(value => <button key={value} type="button" role="tab" data-tab={value} id={`${id}-${value}-tab`} aria-selected={tab === value} aria-controls={`${id}-items`} tabIndex={tab === value ? 0 : -1} onClick={() => changeTab(value)}><span>{value === "buy" ? labels.buyTab : labels.sellTab}</span></button>)}</div>
      <div className="rf-game-shop-items" role="tabpanel" id={`${id}-items`} aria-labelledby={`${id}-${tab}-tab`}>{tab === "buy" ? offerError ? <p className="rf-game-configuration-error" role="alert">{offerError}</p> : shopOffers.length ? <div className="rf-game-shop-offers" role="radiogroup" aria-label={labels.buyTab} data-count={shopOffers.length} data-rows={shopOffers.length > 3 ? 2 : 1}>{shopOffers.map(value => {
        const definition = item(value.itemId)!;
        const accessibleName = `${definition.name}, ${quantity(value.quantity, value.itemId)} for ${money(value.price)}`;
        return <label className="rf-game-shop-offer" key={value.id} data-offer-id={value.id} data-item-id={value.itemId} data-selected={value.id === offer?.id} title={accessibleName}><input type="radio" name={`${id}-offer`} checked={value.id === offer?.id} onChange={() => setSelectedOfferId(value.id)} aria-label={accessibleName} /><span className="rf-game-offer-art rf-game-art-slot" aria-hidden="true">{renderArt(definition)}</span><strong className="rf-game-offer-name">{definition.name}</strong><span className="rf-game-offer-terms"><span>×{quantity(value.quantity, value.itemId)}</span><span>{money(value.price)}</span></span><small className="rf-game-offer-owned">{quantity(itemCounts[value.itemId] ?? 0n, value.itemId)} owned</small></label>;
      })}</div> : <p className="rf-game-empty-copy">{labels.emptyShop}</p> : inventoryEntry && inventoryItem ? <ul className="rf-game-inventory" aria-label="Your items"><li><div className="rf-game-inventory-art rf-game-art-slot">{renderArt(inventoryItem)}</div><div className="rf-game-inventory-copy"><span className="rf-game-inventory-rarity">{inventoryItem.rarity}</span><strong title={inventoryItem.name}>{inventoryItem.name}</strong><span title={sellOffer ? `${quantity(sellOffer.quantity, sellOffer.itemId)} for ${money(sellOffer.price)}` : `${quantity(inventoryEntry.quantity, inventoryEntry.itemId)} owned`}>{sellOffer ? `${quantity(sellOffer.quantity, sellOffer.itemId)} for ${money(sellOffer.price)}` : `${quantity(inventoryEntry.quantity, inventoryEntry.itemId)} owned`}</span></div></li></ul> : <div className="rf-game-empty-inventory"><div className="rf-game-art-slot">{slots.emptyArt ?? <InventoryIcon />}</div><p>{labels.emptyInventory}</p></div>}</div>
      {tab === "sell" && <nav className="rf-game-pagination" aria-label="Inventory pages"><button type="button" disabled={inventory.length < 2} onClick={() => setInventoryPage((inventoryIndex + inventory.length - 1) % inventory.length)} aria-label={labels.previousInventory}>←</button><span role="status" aria-live="polite">{inventory.length ? `${inventoryIndex + 1} / ${inventory.length}` : "0"}</span><button type="button" disabled={inventory.length < 2} onClick={() => setInventoryPage((inventoryIndex + 1) % inventory.length)} aria-label={labels.nextInventory}>→</button></nav>}
    </div>}
    <div className="rf-game-action-zone"><div className="rf-game-action-summary" data-long-amount={summaryAmount !== undefined && formatGameAmount(summaryAmount, currency.decimals).length > 18 || undefined}><span title={summaryLabel}>{summaryLabel}</span>{summaryAmount === undefined ? <strong className="rf-game-text-summary" title={summaryText} aria-label={summaryText}>{summaryText}</strong> : <strong title={summaryText} aria-label={summaryText}><span>{formatGameAmount(summaryAmount, currency.decimals)}</span><span>{currency.symbol}</span></strong>}</div>
      <div className="rf-game-actions" data-pair={stage === "review" || (stage === "reward" && revealReady && Boolean(onSellReward || onShop)) || (stage === "shop" && Boolean(tab === "buy" ? offer : sellOffer)) || undefined}>
        {stage === "activity" && <PanelAction label={missingItems ? labels.openShop : labels.action} primary glyph="↗" disabled={Boolean(choiceError)} onClick={missingItems ? onShop : onAction} />}
        {stage === "review" && <><PanelAction label={labels.confirm} primary glyph="→" onClick={onConfirm} disabled={purchaseDisabled || !purchase || balance < purchase.price} /><PanelAction label={labels.cancel} onClick={onClose} /></>}
        {stage === "pending" && <PanelAction label={labels.pendingTitle} primary glyph="···" disabled />}
        {stage === "working" && <PanelAction label={workingReady ? labels.resolve : labels.waiting} primary glyph={workingReady ? "↑" : "···"} onClick={onResolve} disabled={!workingReady} />}
        {stage === "reward" && <><PanelAction label={revealReady ? labels.keep : labels.reveal} primary glyph={revealReady ? "+" : "→"} onClick={revealReady ? onKeep : () => setSkipSignal(value => value + 1)} />{revealReady && (onSellReward || onShop) && <PanelAction label={onSellReward ? labels.sell : labels.openShop} glyph="→" disabled={Boolean(onSellReward && reward && canSellReward && !canSellReward(reward))} onClick={onSellReward ?? onShop} />}</>}
        {stage === "shop" && <>{tab === "buy" ? offer && <PanelAction label={labels.buy} accessibleLabel={`${labels.buy}: ${quantity(offer.quantity, offer.itemId)} ${offerItem?.name ?? labels.item} for ${money(offer.price)}`} primary glyph="↗" disabled={purchaseDisabled || !offerItem || balance < offer.price} onClick={onBuy ? () => onBuy(offer.id) : undefined} /> : sellOffer && inventoryEntry && <PanelAction label={labels.sell} accessibleLabel={`${labels.sell}: ${inventoryItem?.name ?? labels.item} for ${money(sellOffer.price)}`} primary glyph="↗" disabled={!canSell} onClick={onSell ? () => onSell(inventoryEntry.id, sellOffer.id) : undefined} />}<PanelAction label={labels.returnToActivity} primary={!(tab === "buy" ? offer : sellOffer)} glyph="→" onClick={onReturn ?? onClose} /></>}
      </div><div className="rf-game-feedback" data-error={Boolean(feedbackError) || undefined} role={feedbackError ? "alert" : "status"} aria-live={feedbackError ? "assertive" : "polite"}><span title={feedback}>{feedback}</span></div>
    </div>{slots.footer != null && <div className="rf-game-panel-foot">{slots.footer}</div>}
  </section>;
}

export type GameHudProps = { balance: bigint; currency?: GameCurrency; inventoryCount?: bigint; itemCount?: bigint; itemCountLabel?: string; quest?: string; onReset?: () => void; onInventory?: () => void; labels?: { balance?: string; inventory?: string; reset?: string }; slots?: { inventoryIcon?: ReactNode }; className?: string; style?: GameStyle };
export function GameHud({ balance, currency = DEFAULT_CURRENCY, inventoryCount = 0n, itemCount, itemCountLabel = "items", quest, onReset, onInventory, labels = {}, slots = {}, className = "", style }: GameHudProps) {
  return <div className={`rf-game-hud ${className}`.trim()} style={style}><div className="rf-game-hud-top"><div className="rf-game-wallet"><span>{labels.balance ?? "Balance"}</span><strong title={`${formatGameAmount(balance, currency.decimals)} ${currency.symbol}`}>{formatGameAmount(balance, currency.decimals)} <span>{currency.symbol}</span></strong>{itemCount !== undefined && <span className="rf-game-wallet-items">{formatGameAmount(itemCount)} {itemCountLabel}</span>}</div><div className="rf-game-hud-controls"><button type="button" className="rf-game-inventory-button" onClick={onInventory} disabled={!onInventory} aria-label={labels.inventory ?? `Open inventory, ${formatGameAmount(inventoryCount)} items`}>{slots.inventoryIcon ?? <InventoryIcon />}<span>{formatGameAmount(inventoryCount)}</span></button>{onReset && <button type="button" className="rf-game-reset" onClick={onReset} aria-label={labels.reset ?? "Reset experience"} title={labels.reset ?? "Reset"}>↺</button>}</div></div>{quest && <div className="rf-game-quest"><p>{quest}</p></div>}</div>;
}

export type ActivityPromptProps = { label: string; detail?: string; active?: boolean; pulse?: boolean; onClick?: () => void; keyLabel?: string; className?: string; style?: GameStyle; dataAttributes?: ExperienceDataAttributes };
export function ActivityPrompt({ label, detail, active = false, pulse = false, onClick, keyLabel = "E", className = "", style, dataAttributes }: ActivityPromptProps) {
  return <button type="button" className={`rf-game-hotspot ${className}`.trim()} data-active={active} data-pulse={pulse || undefined} onClick={onClick} disabled={!onClick} aria-label={label} style={style} {...dataAttributes}><Keycap>{keyLabel}</Keycap><span className="rf-game-hotspot-copy"><span>{label}</span>{detail && <small>{detail}</small>}</span></button>;
}
