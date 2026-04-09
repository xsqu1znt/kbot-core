import { CardLike } from "@/types/card.types";
import type { ICardIndex, IndexConfig, NestedIndexConfig } from "@/types/cardIndex.types";
import { CardIndex, NestedCardIndex } from "./CardIndex";

/** Fallback validator applied to indices that don't specify one. Only indexes released and droppable cards. */
const defaultValidator = <T extends CardLike>(card: T): boolean => card.state.released && card.state.droppable;

export class CardPool<Card extends CardLike> {
    readonly all = new Map<string, Card>();
    readonly allReleased = new Map<string, Card>();
    readonly indices = new Map<string, CardIndex<Card>>();
    readonly nestedIndices = new Map<string, NestedCardIndex<Card, any, any>>();
    private readonly indexList: ICardIndex<Card>[] = [];

    constructor(indexConfigs: IndexConfig<Card, any>[], nestedIndexConfigs?: NestedIndexConfig<Card, any, any>[]) {
        for (const config of indexConfigs) {
            const index = new CardIndex<Card>(config.getKey, config.validator ?? defaultValidator);
            this.indices.set(config.name, index);
            this.indexList.push(index);
        }

        if (nestedIndexConfigs) {
            for (const config of nestedIndexConfigs) {
                const index = new NestedCardIndex<Card, any, any>(
                    config.getKey1,
                    config.getKey2,
                    config.validator ?? defaultValidator
                );
                this.nestedIndices.set(config.name, index);
                this.indexList.push(index);
            }
        }
    }

    insert(card: Card): void {
        const existing = this.all.get(card.cardId);
        if (existing) this.remove(existing);

        this.all.set(card.cardId, card);
        if (card.state.released) this.allReleased.set(card.cardId, card);

        for (const index of this.indexList) {
            index.insert(card);
        }
    }

    remove(card: Card): void {
        this.all.delete(card.cardId);
        this.allReleased.delete(card.cardId);

        for (const index of this.indexList) {
            index.remove(card);
        }
    }

    get(cardId: string): Card | undefined {
        return this.all.get(cardId);
    }

    has(cardId: string): boolean {
        return this.all.has(cardId);
    }

    clear(): void {
        this.all.clear();
        this.allReleased.clear();
        for (const index of this.indexList) {
            index.clear();
        }
    }

    getIndex(name: string): CardIndex<Card> | undefined {
        return this.indices.get(name);
    }

    getNestedIndex<K1, K2>(name: string): NestedCardIndex<Card, K1, K2> | undefined {
        return this.nestedIndices.get(name);
    }
}
