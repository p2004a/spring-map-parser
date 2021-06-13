import sevenBin from "7zip-bin";
import { existsSync, promises as fs } from "fs";
import { glob } from "glob";
import { DeepPartial } from "jaz-ts-utils";
import Jimp from "jimp";
import { extractFull } from "node-7z";
import * as StreamZip from "node-stream-zip";
import * as os from "os";
import * as path from "path";
import * as luaparse from "luaparse";
import { Expression, LocalStatement, ReturnStatement, StringLiteral, TableConstructorExpression, TableKeyString } from "luaparse";

import { BufferStream } from "./buffer-stream";
import { defaultWaterOptions, Map, MapInfo, SMD, SMF, WaterOptions } from "./map-model";
const dxt = require("dxt-js");

// https://github.com/spring/spring/tree/develop/rts/Map
// https://springrts.com/wiki/Mapdev:mapinfo.lua
// https://springrts.com/wiki/Mapdev:SMF_format
// https://springrts.com/wiki/Mapdev:SMT_format

export interface MapParserConfig {
    verbose: boolean;
    /**
     * Resolution of tile mipmaps. Can be 4, 8, 16 or 32. Each higher mipmap level doubles the final output resolution, and also resource usage.
     * @default 4
     * */
    mipmapSize: 4 | 8 | 16 | 32;
    /**
     * If you don't want textureMap, set this to true to speed up parsing.
     * @default false
     */
    skipSmt: boolean;
    /**
     * Path to the 7za executable. Will automatically resolve if left unspecified.
     * @default sevenBin.path7za
     */
    path7za: string
    /**
     * Retroactively draw water on top of map texture based on the map's depth
     * @default true
     */
    water: boolean;
}

const mapParserDefaultConfig: Partial<MapParserConfig> = {
    verbose: false,
    mipmapSize: 4,
    skipSmt: false,
    path7za: sevenBin.path7za,
    water: true
};

export class MapParser {
    protected config: MapParserConfig;

    constructor(config?: Partial<MapParserConfig>) {
        this.config = Object.assign({}, mapParserDefaultConfig as Required<MapParserConfig>, config);
    }

    public async parseMap(mapFilePath: string) : Promise<Map> {
        const filePath = path.parse(mapFilePath);
        const fileName = filePath.name;
        const fileExt = filePath.ext;
        const tempDir = path.join(os.tmpdir(), fileName);

        const sigintBinding = process.on("SIGINT", async () => this.sigint(tempDir));

        try {
            if (fileExt !== ".sd7" && fileExt !== ".sdz") {
                throw new Error(`${fileExt} extension is not supported, .sd7 and .sdz only.`);
            }

            const archive = fileExt === ".sd7" ? await this.extractSd7(mapFilePath, tempDir) : await this.extractSdz(mapFilePath, tempDir);

            let mapInfo: DeepPartial<MapInfo> | undefined;
            let smd: SMD | undefined;

            if (archive.mapInfo) {
                mapInfo = await this.parseMapInfo(archive.mapInfo);
            } else {
                smd = await this.parseSMD(archive.smd!);
            }

            const smf = await this.parseSMF(archive.smf);

            let smt: Jimp | undefined;
            if (!this.config.skipSmt) {
                smt = await this.parseSMT(archive.smt, smf.tileIndexMap, smf.mapWidthUnits, smf.mapHeightUnits, this.config.mipmapSize);
            }

            let minHeight = smf.minDepth;
            let maxHeight = smf.maxDepth;
            if (mapInfo?.smf?.minheight && mapInfo.smf.maxheight) {
                minHeight = mapInfo?.smf.minheight;
                maxHeight = mapInfo?.smf.maxheight;
            }

            if (this.config.water && smt) {
                this.applyWater({
                    textureMap: smt,
                    heightMapValues: smf.heightMapValues,
                    minHeight,
                    maxHeight
                });
            }

            this.cleanup(tempDir);

            let scriptName = "";
            if (mapInfo && mapInfo.name && mapInfo.version && mapInfo.name.includes(mapInfo.version!)) {
                scriptName = mapInfo.name;
            } else if (mapInfo && mapInfo.name) {
                scriptName = `${mapInfo.name} ${mapInfo.version}`;
            } else if (archive.smfName) {
                scriptName = archive.smfName;
            }

            return {
                fileName,
                scriptName,
                mapInfo,
                smd,
                smf,
                heightMap: smf.heightMap,
                metalMap: smf.metalMap,
                miniMap: smf.miniMap,
                typeMap: smf.typeMap,
                textureMap: smt
            };
        } catch (err: any) {
            this.cleanup(tempDir);
            sigintBinding.removeAllListeners();
            console.error(err);
            throw err;
        }
    }

    protected async extractSd7(sd7Path: string, outPath: string): Promise<{ smf: Buffer, smt: Buffer, smd?: Buffer, smfName?: string, mapInfo?: Buffer }> {
        return new Promise(async resolve => {
            if (this.config.verbose) {
                console.log(`Extracting .sd7 to ${outPath}`);
            }

            if (!existsSync(sd7Path)) {
                throw new Error(`File not found: ${sd7Path}`);
            }

            await fs.mkdir(outPath, { recursive: true });

            const extractStream = extractFull(sd7Path, outPath, {
                $bin: this.config.path7za,
                recursive: true,
                $cherryPick: ["*.smf", "*.smd", "*.smt", "mapinfo.lua"]
            });

            extractStream.on("end", async () => {
                const smfPath = glob.sync(`${outPath}/**/*.smf`)[0];
                const smtPath = glob.sync(`${outPath}/**/*.smt`)[0];
                const smdPath = glob.sync(`${outPath}/**/*.smd`)[0];
                const mapInfoPath = glob.sync(`${outPath}/mapinfo.lua`)[0];

                const smf = await fs.readFile(smfPath);
                const smfName = smfPath ? path.parse(smfPath).name : undefined;
                const smt = await fs.readFile(smtPath);
                const smd = smdPath ? await fs.readFile(smdPath) : undefined;
                const mapInfo = mapInfoPath ? await fs.readFile(mapInfoPath) : undefined;

                resolve({ smf, smt, smd, smfName, mapInfo });
            });
        });
    }

    protected extractSdz(sdzPath: string, outPath: string): Promise<{ smf: Buffer, smt: Buffer, smd?: Buffer, smfName?: string, mapInfo?: Buffer }> {
        return new Promise(async resolve => {
            if (this.config.verbose) {
                console.log(`Extracting .sdz to ${outPath}`);
            }

            if (!existsSync(sdzPath)) {
                throw new Error(`File not found: ${sdzPath}`);
            }

            await fs.mkdir(outPath, { recursive: true });

            const zip = new StreamZip.async({ file: sdzPath });
            await zip.extract("maps/", outPath);
            await (zip as any).close();

            const smfPath = glob.sync(`${outPath}/**/*.smf`)[0];
            const smtPath = glob.sync(`${outPath}/**/*.smt`)[0];
            const smdPath = glob.sync(`${outPath}/**/*.smd`)[0];
            const mapInfoPath = glob.sync(`${outPath}/mapinfo.lua`)[0];

            const smf = await fs.readFile(smfPath);
            const smfName = smfPath ? path.parse(smfPath).name : undefined;
            const smt = await fs.readFile(smtPath);
            const smd = smdPath ? await fs.readFile(smdPath) : undefined;
            const mapInfo = mapInfoPath ? await fs.readFile(mapInfoPath) : undefined;

            resolve({ smf, smt, smd, smfName, mapInfo });
        });
    }

    protected async parseSMF(smfBuffer: Buffer): Promise<SMF> {
        if (this.config.verbose) {
            console.log("Parsing .smf");
        }

        const bufferStream = new BufferStream(smfBuffer);

        const magic = bufferStream.readString(16);
        const version = bufferStream.readInt();
        const id = bufferStream.readInt(4, true);
        const mapWidth = bufferStream.readInt();
        const mapHeight = bufferStream.readInt();
        const mapWidthUnits = mapWidth / 128;
        const mapHeightUnits = mapHeight / 128;
        const squareSize = bufferStream.readInt();
        const texelsPerSquare = bufferStream.readInt();
        const tileSize = bufferStream.readInt();
        const minDepth = bufferStream.readFloat();
        const maxDepth = bufferStream.readFloat();
        const heightMapIndex = bufferStream.readInt();
        const typeMapIndex = bufferStream.readInt();
        const tileIndexMapIndex = bufferStream.readInt();
        const miniMapIndex = bufferStream.readInt();
        const metalMapIndex = bufferStream.readInt();
        const featureMapIndex = bufferStream.readInt();
        const noOfExtraHeaders = bufferStream.readInt();
        const extraHeaders = bufferStream.read(heightMapIndex - bufferStream.getPosition());

        // TODO
        // for (let i=0; i<noOfExtraHeaders; i++){
        //     const extraHeaderSize = bufferStream.readInt();
        //     const extraHeaderType = bufferStream.readInt();
        //     if (extraHeaderType === 1) { // grass
        //         const extraOffset = bufferStream.readInt();
        //         const grassMapLength = (widthPixels / 4) * (heightPixels / 4);
        //         const grassMap = bufferStream.read(grassMapLength);
        //     }
        // }

        bufferStream.destroy();

        const heightMapSize = (mapWidth+1) * (mapHeight+1);
        const heightMapBuffer = smfBuffer.slice(heightMapIndex, heightMapIndex + heightMapSize * 2);
        const largeHeightMapValues = new BufferStream(heightMapBuffer).readInts(heightMapSize, 2, true);
        const heightMapValues: number[] = [];
        const heightMapColors = largeHeightMapValues.map((val, i) => {
            const percent = val / 65536;
            heightMapValues.push(percent);
            const level = percent * 255;
            return [level, level, level, 255];
        });
        const heightMap = new Jimp({
            data: Buffer.from(heightMapColors.flat()),
            width: mapWidth + 1,
            height: mapHeight + 1
        });

        const typeMapSize = (mapWidth/2) * (mapHeight/2);
        const typeMapBuffer = smfBuffer.slice(typeMapIndex, typeMapIndex + typeMapSize);
        const typeMap = new Jimp({
            data: singleChannelToQuadChannel(typeMapBuffer),
            width: mapWidth / 2,
            height: mapHeight / 2
        });

        const miniMapSize = 699048;
        const miniMapBuffer = smfBuffer.slice(miniMapIndex, miniMapIndex + miniMapSize);
        const miniMapRgbas: Uint8Array = dxt.decompress(miniMapBuffer, 1024, 1024, dxt.flags.DXT1);
        const miniMapRgbaBuffer = Buffer.from(miniMapRgbas);
        const miniMap = new Jimp({
            data: miniMapRgbaBuffer,
            width: 1024,
            height: 1024
        });

        const metalMapSize = (mapWidth/2) * (mapHeight/2);
        const metalMapBuffer = smfBuffer.slice(metalMapIndex, metalMapIndex + metalMapSize);
        const metalMap = new Jimp({
            data: singleChannelToQuadChannel(metalMapBuffer),
            width: mapWidth / 2,
            height: mapHeight / 2
        });

        const tileIndexMapBufferStream = new BufferStream(smfBuffer.slice(tileIndexMapIndex));
        const numOfTileFiles = tileIndexMapBufferStream.readInt();
        const numOfTilesInAllFiles = tileIndexMapBufferStream.readInt();
        const numOfTilesInThisFile = tileIndexMapBufferStream.readInt();
        const smtFileName = tileIndexMapBufferStream.readUntilNull().toString();
        const tileIndexMapSize = (mapWidth / 4) * (mapHeight / 4);
        const tileIndexMap = tileIndexMapBufferStream.readInts(tileIndexMapSize);
        tileIndexMapBufferStream.destroy();

        // TODO
        // const featuresBuffer = buffer.slice(featureMapIndex + 8);
        // const features: string[] = featuresBuffer.toString().split("\u0000").filter(Boolean);

        return {
            magic, version, id, mapWidth, mapWidthUnits, mapHeight, mapHeightUnits, squareSize, texelsPerSquare, tileSize, minDepth, maxDepth,
            heightMapIndex, typeMapIndex, tileIndexMapIndex, miniMapIndex, metalMapIndex, featureMapIndex, noOfExtraHeaders, extraHeaders: [],
            numOfTileFiles, numOfTilesInAllFiles, numOfTilesInThisFile, smtFileName,
            heightMap, typeMap, miniMap, metalMap, tileIndexMap, heightMapValues,
            features: [] // TODO
        };
    }

    protected async parseSMT(smtBuffer: Buffer, tileIndexes: number[], mapWidthUnits: number, mapHeightUnits: number, mipmapSize: 4 | 8 | 16 | 32) : Promise<Jimp> {
        if (this.config.verbose) {
            console.log(`Parsing .smt at mipmap size ${mipmapSize}`);
        }

        const bufferStream = new BufferStream(smtBuffer);

        const magic = bufferStream.readString(16);
        const version = bufferStream.readInt();
        const numOfTiles = bufferStream.readInt();
        const tileSize = bufferStream.readInt();
        const compressionType = bufferStream.readInt();

        const startIndex = mipmapSize === 32 ? 0 : mipmapSize === 16 ? 512 : mipmapSize === 8 ? 640 : 672;
        const dxt1Size = Math.pow(mipmapSize, 2) / 2;
        const rowLength = mipmapSize * 4;

        const refTiles: Buffer[][] = [];
        for (let i=0; i<numOfTiles; i++) {
            const dxt1 = bufferStream.read(680).slice(startIndex, startIndex + dxt1Size);
            const refTileRGBA: Uint8Array = dxt.decompress(dxt1, mipmapSize, mipmapSize, dxt.flags.DXT1);
            const refTileRGBABuffer = Buffer.from(refTileRGBA);
            const refTile: Buffer[] = [];
            for (let k=0; k<mipmapSize; k++) {
                const pixelIndex = k * rowLength;
                const refTileRow = refTileRGBABuffer.slice(pixelIndex, pixelIndex + rowLength);
                refTile.push(refTileRow);
            }
            refTiles.push(refTile);
        }

        const tiles: Buffer[][] = [];
        for (let i=0; i<tileIndexes.length; i++) {
            const refTileIndex = tileIndexes[i];
            const tile = this.cloneTile(refTiles[refTileIndex]);
            tiles.push(tile);
        }

        const tileStrips: Buffer[] = [];
        for (let y=0; y<mapHeightUnits * 32; y++) {
            const tileStrip: Buffer[][] = [];
            for (let x=0; x<mapWidthUnits * 32; x++) {
                const tile = tiles.shift()!;
                tileStrip.push(tile);
            }
            const textureStrip = this.joinTilesHorizontally(tileStrip, mipmapSize);
            tileStrips.push(textureStrip);
        }

        return new Jimp({
            data: Buffer.concat(tileStrips),
            width: mipmapSize * mapWidthUnits * 32,
            height: mipmapSize * mapHeightUnits * 32
        }).background(0x000000);
    }

    protected async parseMapInfo(buffer: Buffer): Promise<MapInfo> {
        if (this.config.verbose) {
            console.log("Parsing mapinfo.lua");
        }

        const mapInfoStr = buffer.toString();
        const parsedMapInfo = luaparse.parse(mapInfoStr, { encodingMode: "x-user-defined", comments: false });
        const rootObj = parsedMapInfo.body[0] as LocalStatement;
        const rootTable = rootObj.init.find(block => block.type === "TableConstructorExpression") as TableConstructorExpression;

        const obj = this.parseMapInfoFields(rootTable.fields);

        return obj as MapInfo;
    }

    protected parseMapInfoFields(fields: (luaparse.TableKey | luaparse.TableKeyString | luaparse.TableValue)[]) {
        const arr: any = [];
        const obj: any = {};

        for (const field of fields) {
            if (field.type === "TableKeyString") {
                if (field.value.type === "StringLiteral" || field.value.type === "NumericLiteral" ||field.value.type === "BooleanLiteral") {
                    obj[field.key.name] = field.value.value;
                } else if (field.value.type === "TableConstructorExpression") {
                    obj[field.key.name] = this.parseMapInfoFields(field.value.fields);
                }
            } else if (field.type === "TableValue") {
                if (field.value.type === "StringLiteral" || field.value.type === "NumericLiteral" ||field.value.type === "BooleanLiteral") {
                    const val = field.value.value;
                    arr.push(val);
                }
            } else if (field.type === "TableKey") {
                if (field.value.type === "StringLiteral" || field.value.type === "NumericLiteral" ||field.value.type === "BooleanLiteral") {
                    const val = field.value.value;
                    if (field.key.type === "NumericLiteral") {
                        arr[field.key.type] = val;
                    }
                } else if (field.value.type === "TableConstructorExpression") {
                    arr.push(this.parseMapInfoFields(field.value.fields));
                }
            }
        }

        if (arr.length) {
            return arr;
        }
        
        return obj;
    }

    protected async parseSMD(buffer: Buffer) : Promise<SMD> {
        if (this.config.verbose) {
            console.log("Parsing .smd");
        }

        const smd = buffer.toString();

        const strPairs = smd.match(/(\w*)\=(.*?)\;/gm)!;
        const strObj: { [key: string]: string } = {};
        const startPositions: Array<{ x: number, z: number }> = [];

        for (const strPair of strPairs) {
            const [key, val] = strPair.slice(0, strPair.length - 1).split("=");
            if (key === "StartPosX") {
                startPositions.push({ x: Number(val), z: 0 });
            } else if (key === "StartPosZ") {
                startPositions[startPositions.length - 1].z = Number(val);
            } else {
                strObj[key] = val;
            }
        }

        return {
            description: strObj.Description,
            tidalStrength: Number(strObj.TidalStrength),
            gravity: Number(strObj.Gravity),
            maxMetal: Number(strObj.MaxMetal),
            extractorRadius: Number(strObj.ExtractorRadius),
            mapHardness: Number(strObj.MapHardness),
            minWind: Number(strObj.MinWind),
            maxWind: Number(strObj.MaxWind),
            startPositions
        };
    }

    protected cloneTile(tile: Buffer[]) : Buffer[] {
        const clone: Buffer[] = [];
        for (const row of tile) {
            clone.push(Buffer.from(row));
        }
        return clone;
    }

    protected joinTilesHorizontally(tiles: Buffer[][], mipmapSize: 4 | 8 | 16 | 32) : Buffer {
        const tileRows: Buffer[] = [];
        for (let y=0; y<mipmapSize; y++) {
            for (let x=0; x<tiles.length; x++) {
                const row = tiles[x].shift()!;
                tileRows.push(row);
            }
        }

        return Buffer.concat(tileRows);
    }

    protected applyWater(options: WaterOptions) {
        if (options.minHeight > 0) {
            // water level is always at 0, so if minDepth is above 0 then map has no water
            return;
        }

        const width = options.textureMap.getWidth();
        const height = options.textureMap.getHeight();
        const heightMapRatio = this.config.mipmapSize / 4;
        const heightMapWidth = Math.floor(width / heightMapRatio) + 1;
        const heightMapHeight = Math.floor(height / heightMapRatio) + 1;
        const depthRange = options.maxHeight - options.minHeight;
        const waterLevelPercent = Math.abs(options.minHeight / depthRange);
        const color = options.rgbColor ?? defaultWaterOptions.rgbColor;
        const colorModifier = options.rgbColor ?? defaultWaterOptions.rgbModifier;

        for (let y=0; y<height; y++) {
            for (let x=0; x<width; x++) {
                const pixelHex = options.textureMap.getPixelColor(x, y);
                const pixelRGBA = Jimp.intToRGBA(pixelHex);
                const heightMapY = Math.floor((y+1)/heightMapRatio);
                const heightMapX = Math.floor(((x+1) % width) / heightMapRatio);
                const heightValue = options.heightMapValues[heightMapWidth * heightMapY + heightMapX];
                if (heightValue < waterLevelPercent - 0.01) {
                    const waterDepth = heightValue / waterLevelPercent;

                    pixelRGBA.r = Math.min(Math.max(((color.r + (pixelRGBA.r * waterDepth)) / 2) * colorModifier.r, 0), 255);
                    pixelRGBA.g = Math.min(Math.max(((color.g + (pixelRGBA.g * waterDepth)) / 2) * colorModifier.g, 0), 255);
                    pixelRGBA.b = Math.min(Math.max(((color.b + (pixelRGBA.b * waterDepth)) / 2) * colorModifier.b, 0), 255);
                    const newHex = Jimp.rgbaToInt(pixelRGBA.r, pixelRGBA.g, pixelRGBA.b, pixelRGBA.a);
                    options.textureMap.setPixelColor(newHex, x, y);
                }
            }
        }
    }

    protected async cleanup(tmpDir: string) {
        if (this.config.verbose) {
            console.log(`Cleaning up temp dir: ${tmpDir}`);
        }

        await fs.rmdir(tmpDir, { recursive: true });
    }

    protected async sigint(tmpDir: string) {
        await this.cleanup(tmpDir);
        process.exit();
    }
}

function singleChannelToQuadChannel(buffer: Buffer) : Buffer {
    const outBuffer: number[] = [];
    buffer.forEach(val => {
        outBuffer.push(val, val, val, 255);
    });

    return Buffer.from(outBuffer);
}
