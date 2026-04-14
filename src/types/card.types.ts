export interface CardLike {
    cardId: string;
    asset: { imageUrl: string; cdn: { filePath: string } };
    state: {
        released: boolean;
        droppable: boolean;
    };
}

export interface InventoryCardLike {
    userId: string;
    cardId: string;
}

export interface MappedInventoryCard<T1 extends CardLike, T2 extends InventoryCardLike> {
    card: T1;
    invCard: T2;
}
