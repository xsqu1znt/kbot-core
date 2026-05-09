import type { FetchedImageWithSharp, MediaDimensions, RenderedMediaWithSharp } from "@/types/image.types.js";

import axios from "axios";
import { AttachmentBuilder } from "discord.js";
import { $, memory } from "qznt";
import sharp from "sharp";

export interface CreateImageGalleryOptions {
    /** Leave blank to use the size of the largest image. */
    baseDimensions?: MediaDimensions;
    /** Max number of items per row. @defaultValue 4 */
    maxRowLength?: number;
    /** Gap size in pixels. @defaultValue 7 */
    spacing?: number;
    /** Whether to automatically scale the images to fit the gallery canvas. */
    autoScale?: boolean;
    /** Quality level from 0-100. @defaultValue 75 */
    quality?: number;
    /** Compression level from 0-9. @defaultValue 7 */
    compressionLevel?: number;
    /** @defaultValue 1 */
    outputScaleFactor?: number;
    /** @defaultValue 'gallery.png' */
    fileName?: string;
}

export class ImageManager {
    private static readonly inflight = new Map<string, Promise<Buffer>>();

    static async withSharp(buffer: Buffer): Promise<FetchedImageWithSharp> {
        const canvas = sharp(buffer);
        const metadata = await canvas.metadata();
        return { canvas, buffer, metadata };
    }

    static async scaleBuffer(buffer: Buffer, factor: number): Promise<Buffer> {
        const image = sharp(buffer);
        const { width, height } = await image.metadata();
        if (!width || !height) throw new Error("[ImageManager] Could not read image dimensions");
        return image.resize(Math.round(width * factor), Math.round(height * factor)).toBuffer();
    }

    static createRenderedMediaData(
        image: sharp.Sharp,
        buffer: Buffer,
        dimensions: MediaDimensions,
        fileName: string
    ): RenderedMediaWithSharp {
        return {
            image,
            buffer,
            dimensions,
            fileName,
            url: `attachment://${fileName}`,
            getFileSize() {
                return {
                    kb: Number((buffer.byteLength / 1024).toFixed(2)),
                    string: memory(buffer.byteLength, 2)
                };
            },
            files() {
                return { files: [new AttachmentBuilder(buffer, { name: this.fileName })] };
            }
        };
    }

    static async fetch(url: string): Promise<Buffer>;
    static async fetch(url: string, withSharp: false): Promise<Buffer>;
    static async fetch(url: string, withSharp: true): Promise<FetchedImageWithSharp>;
    static async fetch(url: string, withSharp?: boolean): Promise<Buffer | FetchedImageWithSharp> {
        const buffer = await this.getOrCreateFetch(url);
        return withSharp ? this.withSharp(buffer) : buffer;
    }

    private static async fetchBuffer(url: string): Promise<Buffer> {
        return $.async
            .retry(
                async () => {
                    const res = await axios.get(url, { responseType: "arraybuffer" });
                    return Buffer.from(res.data);
                },
                { retries: 3 }
            )
            .catch(err => {
                throw new Error(`[ImageManager] Failed to fetch '${url}'`, { cause: err });
            });
    }

    private static getOrCreateFetch(url: string): Promise<Buffer> {
        const existing = this.inflight.get(url);
        if (existing) return existing;

        const promise = this.fetchBuffer(url).finally(() => {
            this.inflight.delete(url);
        });

        this.inflight.set(url, promise);
        return promise;
    }
}
