import type { UpdateQuery } from "mongoose";
import type { CardLike, InventoryCardLike } from "../src/types/card.types.ts";

import assert from "node:assert/strict";
import { CardEngine } from "../src/cards/cardEngine.ts";
import { createCardIndex, createNestedCardIndex } from "../src/cards/cardIndex.ts";

interface TestCard extends CardLike {
    type: "standard";
    rarity: number;
    state: CardLike["state"] & {
        print: number;
    };
}

interface TestInventoryCard extends InventoryCardLike {
    invId: string;
}

class InMemoryCardSchema {
    private readonly cards = new Map<string, TestCard>();
    private queue = Promise.resolve();

    constructor(cards: TestCard[]) {
        for (const card of cards) this.cards.set(card.cardId, structuredClone(card));
    }

    async fetchAll(filter: any = {}): Promise<TestCard[]> {
        let cards = Array.from(this.cards.values());
        const ids = filter.cardId?.$in as string[] | undefined;
        if (ids) cards = cards.filter(card => ids.includes(card.cardId));
        return structuredClone(cards);
    }

    async update(filter: any, update: UpdateQuery<TestCard>): Promise<TestCard | null> {
        let result: TestCard | null = null;

        this.queue = this.queue.then(async () => {
            const card = this.cards.get(filter.cardId);
            if (!card) return;
            if (filter["state.released"] !== undefined && card.state.released !== filter["state.released"]) return;
            if (filter["state.droppable"] !== undefined && card.state.droppable !== filter["state.droppable"]) return;

            const inc = (update as { $inc?: Record<string, number> }).$inc ?? {};
            for (const [path, amount] of Object.entries(inc)) {
                if (path === "state.print") card.state.print += amount;
            }

            result = structuredClone(card);
        });

        await this.queue;
        return result;
    }
}

const cardSchema = new InMemoryCardSchema([
    {
        cardId: "card-1",
        type: "standard",
        rarity: 1,
        asset: { imageUrl: "https://example.com/card.png", cdn: { filePath: "card.png" } },
        state: { released: true, droppable: true, print: 0 }
    }
]);

const engine = new CardEngine<TestCard, TestInventoryCard, "standard">({
    schemas: {
        card: cardSchema as any,
        inventory: {} as any
    },
    indexes: [createCardIndex<TestCard, "standard">("type", card => card.type)],
    nestedIndexes: [
        createNestedCardIndex<TestCard, "standard", number>(
            "typeRarity",
            card => card.type,
            card => card.rarity
        )
    ],
    cardSampleIndex: "type",
    cardSampleNestedIndex: "typeRarity",
    cardSampleRates: [{ type: "standard", oneIn: 1, rarities: [{ rarity: 1, oneIn: 1 }] }],
    sortFn: (a, b) => a.cardId.localeCompare(b.cardId)
});

const minted = (await Promise.all(Array.from({ length: 50 }, () => engine.sampleAndMint(1, { maxAttempts: 100 })))).flat();

const printKeys = minted.map(card => `${card.cardId}:${card.state.print}`);

assert.equal(minted.length, 50);
assert.equal(new Set(printKeys).size, minted.length);
assert.deepEqual(
    minted.map(card => card.state.print).sort((a, b) => a - b),
    Array.from({ length: 50 }, (_, index) => index + 1)
);

console.log(`Minted ${minted.length} unique card print(s) without duplicate allocation.`);
