// @ts-check
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { gardenRecipeId, prepareGardenCraft } from "./garden-craft.mjs";

import {
  gardenGifts,
  giftShelfCapacity,
  isGardenMerchantGift,
} from "../../public/garden-art/gifts.js";

export const gardenCatalogGiftId = z.enum(
  /** @type {[keyof typeof gardenGifts, ...(keyof typeof gardenGifts)[]]} */ (
    Object.keys(gardenGifts)
  ),
);

export const gardenGiftId = z.enum(
  /** @type {[keyof typeof gardenGifts, ...(keyof typeof gardenGifts)[]]} */ (
    Object.keys(gardenGifts).filter(isGardenMerchantGift)
  ),
);
/** @typedef {{kind:"admin"|"agent",id:string,generation:string}} Owner */
/** @typedef {Owner & {name:string}} Person */
/** @typedef {{owner:Person,recipient:(recipient:{kind:"admin"|"agent",id:string})=>Person|undefined}} GiftContext */
/** @typedef {{giftId:keyof typeof gardenGifts,name:string,price:number,originalPrice:number,stock:number,usable:boolean}} GiftOffer */
/** @typedef {import("./garden-craft.mjs").CraftMeta} CraftMeta */
/** @typedef {{id:string,giftId:string,name:string,usable:number,slot:number|null,sourceId:string|null,description:string,note:string,craftMeta?:CraftMeta}} Item */
/** @typedef {{id:string,itemId:string,giftId:string,name:string,note:string,day:number,at:number,giver:Person,recipient:Person,craftMeta?:CraftMeta}} Transfer */

/** @param {{giftId:keyof typeof gardenGifts,price?:number,stock:number}[]} configured */
export function gardenGiftOffers(configured) {
  return configured
    .filter(({ giftId }) => isGardenMerchantGift(giftId))
    .map(({ giftId, price, stock }) => ({
      ...gardenGifts[giftId],
      giftId,
      stock,
      originalPrice: gardenGifts[giftId].price,
      price: price ?? gardenGifts[giftId].price,
    }));
}

const roleId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const recipient = z.strictObject({
  kind: z.enum(["admin", "agent"]),
  id: roleId,
});
const note = z.string().trim().max(280);
const slot = z.number().int().min(1).max(giftShelfCapacity);
const price = z.number().int().min(0).max(1_000_000);
export const giftBudgetLimits = z.strictObject({
  total: price,
  roles: z.record(roleId, price),
});
export const giftActions = /** @type {const} */ ([
  z
    .strictObject({
      kind: z.literal("craft_gift"),
      recipeId: gardenRecipeId,
      harvestIds: z.array(z.uuid()).min(1).max(2),
      price,
      recipient: recipient.optional(),
      note: note.optional(),
    })
    .refine((action) => !action.note || action.recipient),
  z
    .strictObject({
      kind: z.literal("buy_gift"),
      eventId: z.string().regex(/^\d+:[a-z][a-z0-9-]{0,39}$/),
      giftId: gardenGiftId,
      price,
      recipient: recipient.optional(),
      note: note.optional(),
    })
    .refine((action) => !action.note || action.recipient),
  z.strictObject({
    kind: z.literal("send_gift"),
    itemId: z.uuid(),
    recipient,
    note: note.optional(),
  }),
  z.strictObject({ kind: z.literal("use_gift"), itemId: z.uuid() }),
  z.strictObject({
    kind: z.literal("display_gift"),
    itemId: z.uuid(),
    slot,
    description: note.optional(),
    publishNote: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal("withdraw_gift"), slot }),
]);
export const giftAction = z.discriminatedUnion("kind", giftActions);
/** @typedef {z.infer<typeof giftAction>} GiftAction */
const giftKinds = new Set(giftActions.map((schema) => schema.shape.kind.value));

/** @param {import("./garden-service.mjs").Action} action @returns {action is z.infer<typeof giftAction>} */
export function isGiftAction(action) {
  return giftKinds.has(
    /** @type {z.infer<typeof giftAction>["kind"]} */ (action.kind),
  );
}

/** @param {Owner} owner */
function ownerKey(owner) {
  return JSON.stringify([owner.kind, owner.id, owner.generation]);
}

/** @param {Person} person */
function asRecipient({ kind, id, name }) {
  return { kind, id, name };
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function initializeGiftTables(db) {
  const previous = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name='garden_items'")
    .get();
  const legacy = /slot BETWEEN 1 AND 3\b/i.test(String(previous?.sql));
  // SQLite cannot alter a CHECK in place. Rebuild parent and child together
  // inside the store's startup transaction with foreign keys still enabled.
  if (legacy)
    db.exec(`
    ALTER TABLE garden_items RENAME TO garden_items_legacy;
    ALTER TABLE garden_item_transfers RENAME TO garden_item_transfers_legacy;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS garden_items (
      id TEXT PRIMARY KEY,
      gift_id TEXT NOT NULL,
      name TEXT NOT NULL,
      usable INTEGER NOT NULL CHECK (usable IN (0,1)),
      owner TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0,1)),
      source_id TEXT,
      slot INTEGER CHECK (slot BETWEEN 1 AND ${giftShelfCapacity}),
      description TEXT NOT NULL DEFAULT '',
      public_note TEXT NOT NULL DEFAULT '',
      UNIQUE(owner,slot)
    );
    CREATE TABLE IF NOT EXISTS garden_item_transfers (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES garden_items(id),
      gift_id TEXT NOT NULL,
      name TEXT NOT NULL,
      giver TEXT NOT NULL,
      recipient TEXT NOT NULL,
      value TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS garden_gift_spend (
      day INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      used INTEGER NOT NULL CHECK (used>=0),
      PRIMARY KEY(day,agent_id)
    );
  `);
  if (
    !db
      .prepare(
        "SELECT 1 FROM pragma_table_info('garden_items') WHERE name='event_note'",
      )
      .get()
  )
    db.exec(
      "ALTER TABLE garden_items ADD COLUMN event_note TEXT NOT NULL DEFAULT ''",
    );
  if (
    !db
      .prepare(
        "SELECT 1 FROM pragma_table_info('garden_items') WHERE name='craft_meta'",
      )
      .get()
  )
    db.exec("ALTER TABLE garden_items ADD COLUMN craft_meta TEXT");
  if (legacy)
    db.exec(`
    INSERT INTO garden_items(rowid,id,gift_id,name,usable,owner,consumed,source_id,slot,description,public_note)
      SELECT rowid,id,gift_id,name,usable,owner,consumed,source_id,slot,description,public_note FROM garden_items_legacy;
    INSERT INTO garden_item_transfers(rowid,id,item_id,gift_id,name,giver,recipient,value,at)
      SELECT rowid,id,item_id,gift_id,name,giver,recipient,value,at FROM garden_item_transfers_legacy;
    DROP TABLE garden_item_transfers_legacy;
    DROP TABLE garden_items_legacy;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS garden_items_owned ON garden_items(owner,consumed);
    CREATE INDEX IF NOT EXISTS garden_item_received ON garden_item_transfers(recipient);
    CREATE INDEX IF NOT EXISTS garden_item_sent ON garden_item_transfers(giver);
  `);
}

export class GardenGifts {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }

  /** @param {Owner} owner @param {keyof typeof gardenGifts} giftId @param {string} [description] */
  grantEventItem(owner, giftId, description = "") {
    const gift = gardenGifts[giftId];
    this.db
      .prepare(
        "INSERT INTO garden_items(id,gift_id,name,usable,owner,event_note) VALUES(?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        giftId,
        gift.name,
        Number(gift.usable),
        ownerKey(owner),
        description,
      );
  }

  /** @param {number} day @param {Owner} owner @param {import("./garden-service.mjs").State} state */
  budget(day, owner, state) {
    if (owner.kind === "admin") return null;
    const { giftBudgets, giftBudgetGenerations } = state.settings;
    const limit =
      giftBudgetGenerations[owner.id] === owner.generation
        ? (giftBudgets.roles[owner.id] ?? 0)
        : 0;
    const { used, totalUsed } = /** @type {{used:number,totalUsed:number}} */ (
      this.db
        .prepare(
          `
      SELECT coalesce(sum(CASE WHEN agent_id=? THEN used END),0) AS used,
        coalesce(sum(used),0) AS totalUsed FROM garden_gift_spend WHERE day=?
    `,
        )
        .get(owner.id, day)
    );
    const remaining = Math.max(0, limit - used);
    const totalRemaining = Math.max(0, giftBudgets.total - totalUsed);
    return {
      limit,
      used,
      remaining,
      total: giftBudgets.total,
      totalUsed,
      totalRemaining,
      available: Math.min(state.balance, remaining, totalRemaining),
    };
  }

  /** @param {Owner} owner @param {"recipient"|"giver"} field */
  transfers(owner, field) {
    return this.db
      .prepare(
        `SELECT value FROM garden_item_transfers WHERE ${field}=? ORDER BY rowid DESC`,
      )
      .all(ownerKey(owner))
      .map((row) => {
        const { giver, recipient, ...gift } = /** @type {Transfer} */ (
          JSON.parse(String(row.value))
        );
        return {
          ...gift,
          giver: asRecipient(giver),
          recipient: asRecipient(recipient),
        };
      });
  }

  /** @param {number} day @param {Owner} owner @param {import("./garden-service.mjs").State} state
   * @param {number} price @param {(amount:number)=>void} pay */
  spend(day, owner, state, price, pay) {
    const budget = this.budget(day, owner, state);
    if (
      budget &&
      (!budget.limit ||
        !budget.total ||
        price > Math.min(budget.remaining, budget.totalRemaining))
    )
      throw Error("GARDEN_GIFT_BUDGET_LOW");
    pay(price);
    if (budget)
      this.db
        .prepare(
          `INSERT INTO garden_gift_spend VALUES(?,?,?)
        ON CONFLICT(day,agent_id) DO UPDATE SET used=used+excluded.used`,
        )
        .run(day, owner.id, price);
  }

  /** @param {Owner} owner */
  shelfFor(owner) {
    return this.db
      .prepare(
        `
      SELECT slot,gift_id AS giftId,name,COALESCE(NULLIF(description,''),event_note) AS description,public_note AS note,craft_meta
      FROM garden_items WHERE owner=? AND consumed=0 AND slot IS NOT NULL ORDER BY slot
    `,
      )
      .all(ownerKey(owner))
      .map(({ slot, giftId, name, description, note, craft_meta }) => ({
        slot: Number(slot),
        giftId: String(giftId),
        name: String(name),
        description: String(description),
        note: String(note),
        ...(typeof craft_meta === "string" && {
          craftMeta: JSON.parse(craft_meta),
        }),
      }));
  }

  /** @param {Person[]} owners */
  communityShelves(owners) {
    return owners.flatMap((owner) => {
      const items = this.shelfFor(owner).map(({ note, ...item }) => ({
        ...item,
        ...(note && { note }),
      }));
      return items.length ? [{ owner: asRecipient(owner), items }] : [];
    });
  }

  /** @param {Owner} owner @param {number} day @param {import("./garden-service.mjs").State} state */
  view(owner, day, state) {
    const received = this.transfers(owner, "recipient");
    const sent = this.transfers(owner, "giver");
    const sources = new Map(received.map((row) => [row.id, row]));
    const items = /** @type {Array<Item & {craft_meta:string|null}>} */ (
      /** @type {unknown} */ (
        this.db
          .prepare(
            `
      SELECT id,gift_id AS giftId,name,usable,slot,source_id AS sourceId,COALESCE(NULLIF(description,''),event_note) AS description,public_note AS note,craft_meta
      FROM garden_items WHERE owner=? AND consumed=0 ORDER BY rowid DESC
    `,
          )
          .all(ownerKey(owner))
      )
    ).map(({ sourceId, craft_meta, ...row }) => ({
      ...row,
      usable: Boolean(row.usable),
      ...(craft_meta && { craftMeta: JSON.parse(craft_meta) }),
      source: sourceId ? sources.get(sourceId) : undefined,
    }));
    return {
      items,
      received,
      sent,
      shelf: this.shelfFor(owner),
      budget: this.budget(day, owner, state),
    };
  }

  /** @param {string} id @param {Owner} owner */
  owned(id, owner) {
    const item = /** @type {(Item & {craft_meta:string|null})|undefined} */ (
      this.db
        .prepare(
          `
      SELECT id,gift_id AS giftId,name,usable,slot,source_id AS sourceId,COALESCE(NULLIF(description,''),event_note) AS description,public_note AS note,craft_meta
      FROM garden_items WHERE id=? AND owner=? AND consumed=0
    `,
        )
        .get(id, ownerKey(owner))
    );
    if (!item) throw Error("GARDEN_ITEM_UNAVAILABLE");
    const { craft_meta, ...fields } = item;
    return {
      ...fields,
      ...(craft_meta && { craftMeta: JSON.parse(craft_meta) }),
    };
  }

  /** @param {string} itemId @param {{giftId:string,name:string,craftMeta?:CraftMeta}} gift @param {Person} giver @param {Person} recipient @param {string} note @param {number} day @param {number} at */
  transfer(itemId, gift, giver, recipient, note, day, at) {
    const transfer = {
      id: randomUUID(),
      itemId,
      giftId: gift.giftId,
      name: gift.name,
      ...(gift.craftMeta && { craftMeta: gift.craftMeta }),
      giver,
      recipient,
      note,
      day,
      at,
    };
    this.db
      .prepare(
        `
      INSERT INTO garden_item_transfers(id,item_id,gift_id,name,giver,recipient,value,at)
      VALUES(?,?,?,?,?,?,?,?)
    `,
      )
      .run(
        transfer.id,
        itemId,
        gift.giftId,
        gift.name,
        ownerKey(giver),
        ownerKey(recipient),
        JSON.stringify(transfer),
        at,
      );
    this.db
      .prepare(
        `
      UPDATE garden_items SET owner=?,source_id=?,slot=NULL,description='',public_note='' WHERE id=?
    `,
      )
      .run(ownerKey(recipient), transfer.id, itemId);
    return transfer;
  }

  /** @param {z.infer<typeof giftAction>} action @param {GiftContext} context @param {number} day @param {number} now
   * @param {import("./garden-service.mjs").State} state @param {import("./garden-events.mjs").GardenEvents} events @param {(amount:number)=>void} pay
   * @param {(transfer:Transfer)=>void} [recordTransfer] @param {boolean} [hasRack] */
  apply(
    action,
    context,
    day,
    now,
    state,
    events,
    pay,
    recordTransfer,
    hasRack = false,
  ) {
    const { owner } = context;
    const key = ownerKey(owner);
    const recipient =
      "recipient" in action && action.recipient
        ? context.recipient(action.recipient)
        : undefined;
    if (
      "recipient" in action &&
      action.recipient &&
      (!recipient || ownerKey(recipient) === key)
    )
      throw Error("GARDEN_RECIPIENT_UNAVAILABLE");
    if (action.kind === "buy_gift") {
      const event = events.get(day);
      if (
        !event ||
        event.id !== action.eventId ||
        event.kind !== "merchant" ||
        event.status !== "open"
      )
        throw Error("GARDEN_EVENT_EXPIRED");
      const offer = event.giftOffers?.find(
        (row) => row.giftId === action.giftId,
      );
      if (!offer) throw Error("GARDEN_EVENT_OFFER");
      if (!offer.stock) throw Error("GARDEN_STOCK_UNAVAILABLE");
      if (offer.price !== action.price) throw Error("GARDEN_PRICE_CHANGED");
      this.spend(day, owner, state, offer.price, pay);
      offer.stock--;
      events.update(day, event);
      const itemId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO garden_items(id,gift_id,name,usable,owner) VALUES(?,?,?,?,?)",
        )
        .run(itemId, offer.giftId, offer.name, Number(offer.usable), key);
      const transfer =
        recipient &&
        this.transfer(
          itemId,
          offer,
          owner,
          recipient,
          action.note ?? "",
          day,
          now,
        );
      if (transfer) recordTransfer?.(transfer);
      return {
        itemId,
        giftId: offer.giftId,
        name: offer.name,
        price: offer.price,
        eventId: event.id,
        recipient: asRecipient(recipient ?? owner),
        transferId: transfer?.id,
      };
    }
    if (action.kind === "craft_gift") {
      const { price, giftId, craftMeta } = prepareGardenCraft(
        this.db,
        state,
        context,
        action,
        hasRack,
      );
      const gift = gardenGifts[giftId];
      this.spend(day, owner, state, price, pay);
      const use = this.db.prepare(
        "UPDATE garden_harvests SET quantity=quantity-1,last_use='craft_gift' WHERE id=? AND quantity>0",
      );
      for (const harvestId of action.harvestIds)
        if (use.run(harvestId).changes !== 1)
          throw Error("GARDEN_RECIPE_INGREDIENTS");
      const itemId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO garden_items(id,gift_id,name,usable,owner,craft_meta) VALUES(?,?,?,?,?,?)",
        )
        .run(
          itemId,
          giftId,
          gift.name,
          Number(gift.usable),
          key,
          JSON.stringify(craftMeta),
        );
      const transfer =
        recipient &&
        this.transfer(
          itemId,
          { giftId, name: gift.name, craftMeta },
          owner,
          recipient,
          action.note ?? "",
          day,
          now,
        );
      if (transfer) recordTransfer?.(transfer);
      return {
        itemId,
        giftId,
        name: gift.name,
        price,
        craftMeta,
        recipient: asRecipient(recipient ?? owner),
        transferId: transfer?.id,
      };
    }
    if (action.kind === "withdraw_gift") {
      this.clearSlot(key, action.slot);
      return { slot: action.slot };
    }
    const item = this.owned(action.itemId, owner);
    if (action.kind === "send_gift") {
      if (!recipient) throw Error("GARDEN_RECIPIENT_UNAVAILABLE");
      const transfer = this.transfer(
        item.id,
        item,
        owner,
        recipient,
        action.note ?? "",
        day,
        now,
      );
      recordTransfer?.(transfer);
      return {
        itemId: item.id,
        giftId: item.giftId,
        name: item.name,
        recipient: asRecipient(recipient),
        transferId: transfer.id,
      };
    }
    if (action.kind === "use_gift") {
      if (!item.usable) throw Error("GARDEN_ITEM_NOT_USABLE");
      this.db
        .prepare(
          "UPDATE garden_items SET consumed=1,slot=NULL,description='',public_note='' WHERE id=?",
        )
        .run(item.id);
      return { itemId: item.id, giftId: item.giftId, name: item.name };
    }
    const source =
      action.publishNote &&
      item.sourceId &&
      this.db
        .prepare(
          "SELECT value FROM garden_item_transfers WHERE id=? AND recipient=?",
        )
        .get(item.sourceId, key);
    const note = source ? JSON.parse(String(source.value)).note : "";
    this.clearSlot(key, action.slot);
    this.db
      .prepare(
        "UPDATE garden_items SET slot=?,description=?,public_note=? WHERE id=?",
      )
      .run(action.slot, action.description ?? "", note, item.id);
    return { itemId: item.id, slot: action.slot };
  }

  /** @param {string} owner @param {number} slot */
  clearSlot(owner, slot) {
    this.db
      .prepare(
        "UPDATE garden_items SET slot=NULL,description='',public_note='' WHERE owner=? AND slot=?",
      )
      .run(owner, slot);
  }
}
