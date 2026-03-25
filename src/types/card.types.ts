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
