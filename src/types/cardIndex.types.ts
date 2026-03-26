export type Validator<T> = (card: T) => boolean;
export type KeyExtractor<T, K> = (card: T) => K | undefined;

export interface IndexConfig<T, K = string> {
    name: string;
    getKey: KeyExtractor<T, K>;
    validator?: Validator<T>;
}

export interface NestedIndexConfig<T, K1 = string, K2 = number> {
    name: string;
    getKey1: KeyExtractor<T, K1>;
    getKey2: KeyExtractor<T, K2>;
    validator?: Validator<T>;
}

export interface ICardIndex<T> {
    insert(card: T): void;
    remove(card: T): void;
    clear(): void;
}
