import type { ProjectionType } from "mongoose";
import type { MongoSchemaBuilder } from "vimcord";
import type { CardLike, InventoryCardLike, MappedInventoryCard } from "@/types/card.types.js";
import type { CardEngine } from "./cardEngine.js";

interface FetchInventoryCardOptions<InvCard extends InventoryCardLike> {
    userId?: string;
    projection?: ProjectionType<InvCard>;
}

export interface InventoryEngineConfig<
    T1 extends CardLike,
    T2 extends InventoryCardLike,
    K extends string | number = string | number
> {
    cardEngine: CardEngine<T1, T2, K>;
    inventorySchema: MongoSchemaBuilder<T2>;
}

export class InventoryEngine<
    T1 extends CardLike,
    T2 extends InventoryCardLike,
    K extends string | number = string | number
> {
    constructor(private readonly config: InventoryEngineConfig<T1, T2, K>) {}

    /** Fetches an inventory card and maps it to its actual card. */
    async fetch(invId: string, options?: FetchInventoryCardOptions<T2>): Promise<MappedInventoryCard<T1, T2> | undefined>;
    async fetch(invIds: string | string[], options?: FetchInventoryCardOptions<T2>): Promise<MappedInventoryCard<T1, T2>[]>;
    async fetch(
        invIds: string | string[],
        options: FetchInventoryCardOptions<T2> = {}
    ): Promise<(MappedInventoryCard<T1, T2> | undefined) | MappedInventoryCard<T1, T2>[]> {
        const { userId, projection } = options;

        const isArray = Array.isArray(invIds);
        const cardIdsArray = isArray ? invIds : [invIds];
        const invCards = await this.config.inventorySchema.fetchAll(
            {
                ...(userId && { userId }),
                invId: { $in: cardIdsArray }
            },
            projection
        );

        const mapped = await this.mapCards(invCards);
        return isArray ? mapped : mapped[0];
    }

    async fetchAll(options: FetchInventoryCardOptions<T2> = {}): Promise<MappedInventoryCard<T1, T2>[]> {
        const { userId, projection } = options;

        const invCards = await this.config.inventorySchema.fetchAll({ ...(userId && { userId }) }, projection);
        return this.mapCards(invCards);
    }

    /** Maps inventory cards to their actual card, filtering out cards that don't exist. */
    async mapCards(invCards: T2[]): Promise<MappedInventoryCard<T1, T2>[]> {
        return (
            await Promise.all(
                invCards
                    // NOTE: I asserted here just for the type, it'll never throw because of filtering
                    .map(async invCard => ({ card: (await this.config.cardEngine.get(invCard.cardId))!, invCard }))
            )
        ).filter(({ card }) => card);
    }
}
