export type CsvColumn<T> = {
    header: string;
    get: (row: T) => string | number | null | undefined;
};
export declare function csvForRows<T>(rows: T[], columns: CsvColumn<T>[]): string;
export declare function withBom(s: string): string;
