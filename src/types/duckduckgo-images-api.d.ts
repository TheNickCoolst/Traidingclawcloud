declare module "duckduckgo-images-api" {
    export function image_search(query: { query: string; moderate?: boolean; iterations?: number }): Promise<any[]>;
    export function search(query: any): Promise<any[]>;
}
