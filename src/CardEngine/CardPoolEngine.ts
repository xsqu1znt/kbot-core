import { useBunnyCDN } from "@/MediaTools";
import { CardLike } from "@/types/card.types";
import { IndexConfig, NestedIndexConfig } from "@/types/cardIndex.types";
import { RootFilterQuery, UpdateQuery } from "mongoose";
import { EventEmitter } from "node:events";
import { choice, str, weighted } from "qznt";
import type { MongoSchemaBuilder } from "vimcord";
import { CardIndex, NestedCardIndex } from "./CardIndex";
import { CardPool } from "./CardPool";
import { CardPoolCache } from "./CardPoolCache";

interface DropRateRarity {
    rarity: number;
    oneIn: number;
}

interface DropRateTier {
    type: string | number;
    oneIn: number;
    rarities?: DropRateRarity[];
}

interface DropRateConfig {
    tiers: DropRateTier[];
}

interface CompiledWeightRarity {
    rarity: number;
    oneIn: number;
    compiledWeight: number;
}

interface CompiledWeightTier {
    type: string | number;
    oneIn: number;
    compiledWeight: number;
    rarities?: CompiledWeightRarity[];
}

type SortFunction<T> = (a: T, b: T) => number;

type FuzzySearchFieldGetter<Card> = (card: Card) => string | number | undefined;

export interface CardPoolEngineConfig<Card extends CardLike> {
    cardSchema: MongoSchemaBuilder<Card>;
    inventoryCardSchema: MongoSchemaBuilder<any>;
    indices: IndexConfig<Card, any>[];
    nestedIndices?: NestedIndexConfig<Card, any, any>[];
    dropRates: DropRateConfig;
    sortFn: SortFunction<Card>;
}

export interface CardPoolEngineEvents<T> {
    initialized: [];
    refreshed: [count: number];
    cardInserted: [card: T];
    cardRemoved: [card: T];
    cardUpdated: [card: T, oldCard: T];
    error: [error: Error];
}

export interface InsertNewCardData<T> {
    namePrefix: string;
    imageUrl: string;
    cdnRoute: string;
    card: Partial<T>;
}

export interface SampleOptions {
    userId?: string;
    excludeCardIds?: string[];
}

export type SampleResult<Card extends CardLike> = [cards: Card[], failReason?: string];

export interface FuzzySearchOptions<
    Card extends CardLike,
    FuzzySearchFields extends Record<string, FuzzySearchFieldGetter<Card>>
> {
    limit?: number;
    released?: boolean;
    excludeFields?: (keyof FuzzySearchFields)[];
}

export interface FuzzySearchIdentityResult {
    /** Example: "aespa" or "Jaemin" */
    matchedKey: string;
    /** Example: "byName" */
    indexType: string;
    /** Example: "Name" */
    indexTypeStripped: string;
    /** Combined: `${matchedKey}-${indexType}` */
    identity: string;
    cardIds: string[];
}

function buildCardFilename(namePrefix: string, imageUrl: string) {
    const imageExt = imageUrl.split("?").shift()?.split(".").pop();
    return `${namePrefix.toUpperCase()}_CARD_${Date.now()}${str(2, "alpha", { casing: "upper" })}.${imageExt}`;
}

function compileWeightPool<T extends CardLike>(dropRates: DropRateConfig): CompiledWeightTier[] {
    const totalRawBaseWeight = dropRates.tiers.reduce((acc, cur) => acc + 1 / cur.oneIn, 0);

    return dropRates.tiers.map(tier => {
        const compiled: CompiledWeightTier = {
            type: tier.type,
            oneIn: tier.oneIn,
            compiledWeight: 1 / tier.oneIn / totalRawBaseWeight
        };

        if (tier.rarities) {
            const totalRawRarityWeight = tier.rarities.reduce((acc, cur) => acc + 1 / cur.oneIn, 0);
            compiled.rarities = tier.rarities.map(r => ({
                rarity: r.rarity,
                oneIn: r.oneIn,
                compiledWeight: 1 / r.oneIn / totalRawRarityWeight
            }));
        }

        return compiled;
    });
}

export class CardPoolEngine<
    Card extends CardLike,
    FuzzySearchFields extends Record<string, FuzzySearchFieldGetter<Card>> = Record<string, FuzzySearchFieldGetter<Card>>
> extends EventEmitter {
    private cache: CardPoolCache<Card>;
    private compiledDropRates: CompiledWeightTier[];
    private initialized = false;

    constructor(
        private config: CardPoolEngineConfig<Card>,
        private fuzzySearchFields: FuzzySearchFields
    ) {
        super();

        this.cache = new CardPoolCache<Card>(config.cardSchema, config.indices, config.nestedIndices);
        this.compiledDropRates = compileWeightPool(config.dropRates);

        this.cache.on("refreshed", count => this.emit("refreshed", count));
        this.cache.on("cardInserted", card => this.emit("cardInserted", card));
        this.cache.on("cardRemoved", card => this.emit("cardRemoved", card));
        this.cache.on("cardUpdated", (card, oldCard) => this.emit("cardUpdated", card, oldCard));
        this.cache.on("error", err => this.emit("error", err));
    }

    get pool(): CardPool<Card> {
        return this.cache.cardPool;
    }

    async init(): Promise<this> {
        await this.cache.init();
        this.initialized = true;
        this.emit("initialized");
        return this;
    }

    private async ensureInit(): Promise<void> {
        if (!this.initialized) await this.init();
    }

    /** Fuzzy searches the card pool and returns a list of cards. */
    fuzzySearch(query: string, options: FuzzySearchOptions<Card, FuzzySearchFields> = {}): Card[] {
        const { limit = 25, released, excludeFields } = options;

        const pool = this.cache.cardPool;
        const source = released ? pool.allReleased : pool.all;
        const lowerQuery = query.toLowerCase();

        const fieldGetters = Object.entries(this.fuzzySearchFields)
            .filter(([name]) => !excludeFields?.length || !excludeFields.includes(name))
            .map(([, getter]) => getter);

        const results: Card[] = [];
        for (const card of source.values()) {
            if (results.length >= limit) break;

            for (const getter of fieldGetters) {
                const match = getter(card);
                if (match === undefined) continue;

                if (typeof match === "string" && match.startsWith(lowerQuery)) {
                    results.push(card);
                    break;
                } else if (typeof match === "number" && match.toString() === lowerQuery) {
                    results.push(card);
                    break;
                }
            }
        }

        return results;
    }

    /** Fuzzy searches the card pool and returns a list of cards by their identifiers.. */
    fuzzySearchIdentity(query: string, options: { limit?: number } = {}): FuzzySearchIdentityResult[] {
        const { limit = 25 } = options;

        const pool = this.cache.cardPool;
        const lowerQuery = query.toLowerCase();

        const results: FuzzySearchIdentityResult[] = [];

        for (const [indexType, index] of pool.indices) {
            if (results.length >= limit) break;

            for (const [matchedKey, cardIds] of index.entries()) {
                if (results.length >= limit) break;
                if (typeof matchedKey !== "string") continue;

                if (matchedKey.toLowerCase().startsWith(lowerQuery)) {
                    const _cardIds = Array.from(cardIds);
                    const _indexTypeStripped = indexType.replace("by", "");
                    const _identity = `${indexType}-${matchedKey}`;

                    results.push({
                        matchedKey,
                        indexType,
                        indexTypeStripped: _indexTypeStripped,
                        identity: _identity,
                        cardIds: _cardIds
                    });
                }
            }
        }

        return results;
    }

    /** Gets a card from the card pool. */
    get(cardId: string, released?: boolean): Card | undefined {
        const pool = this.cache.cardPool;
        return released ? pool.allReleased.get(cardId) : pool.all.get(cardId);
    }

    getMany(cardIds: string[], released?: boolean): Card[] {
        const pool = this.cache.cardPool;
        const results: Card[] = [];
        for (const cardId of cardIds) {
            const card = released ? pool.allReleased.get(cardId) : pool.all.get(cardId);
            if (card) results.push(card);
        }
        return this.sort(results);
    }

    /** Samples a number of cards from the card pool. */
    sample(limit: number, options?: SampleOptions): SampleResult<Card> {
        const pool = this.cache.cardPool;
        const picked = new Set<string>(options?.excludeCardIds);
        const results: Card[] = [];

        for (let i = 0; i < limit; i++) {
            const selectedType = weighted(this.compiledDropRates, t => t.compiledWeight);

            let selectedRarity: number | undefined;
            if (selectedType.rarities) {
                selectedRarity = weighted(selectedType.rarities, r => r.compiledWeight).rarity;
            }

            let candidates: Set<string> | undefined;

            for (const [, nestedIndex] of pool.nestedIndices) {
                if (nestedIndex instanceof NestedCardIndex) {
                    const found = nestedIndex.get(selectedType.type, selectedRarity);
                    if (found.size) {
                        candidates = new Set(found);
                        break;
                    }
                }
            }

            if (!candidates?.size) {
                for (const [, index] of pool.indices) {
                    if (index instanceof CardIndex) {
                        const found = index.get(selectedType.type);
                        if (found.size) {
                            candidates = new Set(found);
                            break;
                        }
                    }
                }
            }

            if (!candidates?.size) candidates = new Set(pool.all.keys());

            const available = Array.from(candidates).filter(id => !picked.has(id));
            if (!available.length) return [[], "Not enough cards were available to drop."];

            const cardId = choice(available);
            picked.add(cardId);
            results.push(pool.all.get(cardId)!);
        }

        return [results];
    }

    /** Samples a number of cards from the card pool and modifies them, then returns the modified cards. */
    async sampleAndModify(limit: number, update: UpdateQuery<Card>, options?: SampleOptions): Promise<SampleResult<Card>> {
        const [cards, failReason] = this.sample(limit, options);
        if (failReason) return [[], failReason];

        const modifiedCards = await this.modifyMany(
            cards.map(c => c.cardId),
            update
        );
        if (!modifiedCards.length) return [[], "Failed to modify cards."];
        return [modifiedCards];
    }

    /** Sorts a list of cards by an opinionated order. */
    sort(cards: Card[]): Card[] {
        return [...cards].sort(this.config.sortFn);
    }

    /** Creates a new card in the database and uploads its image to the CDN. */
    async insert(data: InsertNewCardData<Card>, stageFns?: [() => any, () => any, () => any]): Promise<Card> {
        await this.ensureInit();

        const existing = this.pool.get(data.card.cardId!);
        if (existing) throw new Error(`Card (${data.card.cardId}) already exists`);
        if (!data.imageUrl) throw new Error("Card must have an image URL");

        const bunnyCDN = useBunnyCDN();

        await stageFns?.[0]();
        const imageResult = await bunnyCDN.uploadImageFromUrl(
            data.imageUrl,
            buildCardFilename(data.namePrefix, data.imageUrl),
            data.cdnRoute
        );
        if (!imageResult.success) throw new Error("Failed to upload card image");

        await stageFns?.[1]();
        const [card] = await this.config.cardSchema.create([
            { ...data.card, asset: { imageUrl: imageResult.cdnUrl!, cdn: { filePath: imageResult.path! } } } as any
        ]);
        if (!card) throw new Error("Failed to insert card into database");

        await stageFns?.[2]();
        await this.cache.refreshMany([card.cardId]);

        return card;
    }

    /** Modifies a card in the database. Supports atomic operators e.g. $inc. */
    async modify(cardId: string, update: UpdateQuery<Card>): Promise<Card | null> {
        await this.ensureInit();

        const oldCard = this.pool.get(cardId);
        if (!oldCard) return null;

        const updated = await this.config.cardSchema.update({ cardId }, update, { returnDocument: "after" });
        if (!updated) return null;

        this.pool.insert(updated);
        this.emit("cardUpdated", updated, oldCard);
        return updated;
    }

    /** Modifies multiple cards in the database. Supports atomic operators e.g. $inc. */
    async modifyMany(cardIds: string[], update: UpdateQuery<Card>): Promise<Card[]> {
        await this.ensureInit();

        const oldCards = cardIds.map(id => this.pool.get(id));
        if (oldCards.length !== cardIds.length) return [];

        const updateRes = await this.config.cardSchema.updateAll({ cardId: { $in: cardIds } }, update);
        if (updateRes.modifiedCount !== cardIds.length) return [];

        const updated = await this.config.cardSchema.fetchAll({ cardId: { $in: cardIds } });
        if (updated.length !== cardIds.length) return [];

        updated.forEach(card => {
            this.pool.insert(card);
            this.emit(
                "cardUpdated",
                card,
                oldCards.find(c => c?.cardId === card.cardId)
            );
        });

        return updated;
    }

    /** Removes a card from the database and CDN, and clears it from player inventories. */
    async delete(cardId: string): Promise<boolean> {
        await this.ensureInit();

        const existing = this.pool.get(cardId);
        if (!existing) return false;

        try {
            const bunnyCDN = useBunnyCDN();
            await bunnyCDN.delete(existing.asset.cdn.filePath);
            await this.config.cardSchema.delete({ cardId });
            await this.cache.removeMany([cardId]);
            await this.config.inventoryCardSchema.deleteAll({ cardId });
            return true;
        } catch (err) {
            console.error("Failed to delete card", err);
            return false;
        }
    }

    /** Swaps the image of a card in the database. */
    async swapImage(
        cardId: string,
        newImageUrl: string,
        options: { namePrefix: string; cdnRoute: string }
    ): Promise<Card | null> {
        await this.ensureInit();

        const oldCard = this.get(cardId);
        if (!oldCard) return null;

        const bunnyCDN = useBunnyCDN();

        const imageResult = await bunnyCDN.uploadImageFromUrl(
            newImageUrl,
            buildCardFilename(options.namePrefix, newImageUrl),
            options.cdnRoute
        );
        if (!imageResult.success) return null;

        await bunnyCDN.delete(oldCard.asset.cdn.filePath);

        const updated = await this.config.cardSchema.update(
            { cardId },
            { "asset.imageUrl": imageResult.cdnUrl!, "asset.cdn.filePath": imageResult.path! },
            { returnDocument: "after" }
        );
        if (!updated) return null;

        this.pool.insert(updated);
        this.emit("cardUpdated", updated, oldCard);
        return updated;
    }

    /** Releases a batch of cards and updates the cache. */
    async release(cardIds: string[]): Promise<Card[]> {
        await this.ensureInit();

        const oldCards = this.getMany(cardIds);
        await this.config.cardSchema.updateAll({ cardId: { $in: cardIds } }, { "state.released": true });
        await this.cache.refreshMany(cardIds);

        const updated = this.getMany(cardIds, true);
        for (let i = 0; i < updated.length; i++) {
            this.emit("cardUpdated", updated[i], oldCards[i]);
        }
        return updated;
    }

    async refresh(cardIds?: string[]): Promise<void> {
        if (cardIds) {
            await this.cache.refreshMany(cardIds);
        } else {
            await this.cache.refreshAll();
        }
    }
}

export function createCardPoolEngine<
    Card extends CardLike,
    FuzzySearchFields extends Record<string, FuzzySearchFieldGetter<Card>> = Record<string, FuzzySearchFieldGetter<Card>>
>(config: CardPoolEngineConfig<Card>, fuzzySearchFields: FuzzySearchFields) {
    const engine = new CardPoolEngine<Card, FuzzySearchFields>(config, fuzzySearchFields);
    let initPromise: Promise<CardPoolEngine<Card, FuzzySearchFields>> | null = null;

    const useCardEngine = async (): Promise<CardPoolEngine<Card, FuzzySearchFields>> => {
        if (initPromise) return initPromise;
        initPromise = engine.init();
        return initPromise;
    };

    const useCardPool = async (): Promise<CardPool<Card>> => {
        const eng = await useCardEngine();
        return eng.pool;
    };

    return { engine, useCardEngine, useCardPool };
}
