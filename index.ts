import { Buffer } from "buffer";
import fsPath from "path";
import process from "process";
import stream from "stream";

const getPosixApi = memoize(_getPosixApi);

const platform = Process.platform;
const pointerSize = Process.pointerSize;

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFCHR = 0x2000;
const S_IFBLK = 0x6000;
const S_IFIFO = 0x1000;
const S_IFLNK = 0xa000;
const S_IFSOCK = 0xc000;

type ApiConstants = Record<string, number>;

const universalConstants: ApiConstants = {
    S_IFMT,
    S_IFREG,
    S_IFDIR,
    S_IFCHR,
    S_IFBLK,
    S_IFIFO,
    S_IFLNK,
    S_IFSOCK,

    S_IRWXU: 448,
    S_IRUSR: 256,
    S_IWUSR: 128,
    S_IXUSR: 64,
    S_IRWXG: 56,
    S_IRGRP: 32,
    S_IWGRP: 16,
    S_IXGRP: 8,
    S_IRWXO: 7,
    S_IROTH: 4,
    S_IWOTH: 2,
    S_IXOTH: 1,

    DT_UNKNOWN: 0,
    DT_FIFO: 1,
    DT_CHR: 2,
    DT_DIR: 4,
    DT_BLK: 6,
    DT_REG: 8,
    DT_LNK: 10,
    DT_SOCK: 12,
    DT_WHT: 14,
};
const platformConstants: Partial<Record<Platform, ApiConstants>> = {
    linux: {
        O_RDONLY: 0x0,
        O_WRONLY: 0x1,
        O_RDWR: 0x2,
        O_CREAT: 0x40,
        O_EXCL: 0x80,
        O_NOCTTY: 0x100,
        O_TRUNC: 0x200,
        O_APPEND: 0x400,
        O_DIRECTORY: 0x10000,
        O_NOATIME: 0x40000,
        O_NOFOLLOW: 0x20000,
        O_SYNC: 0x101000,
        O_DSYNC: 0x1000,
        O_DIRECT: 0x4000,
        O_NONBLOCK: 0x800,
    },
};
const constants = {
    ...universalConstants,
    ...platformConstants[platform]
};

const INVALID_HANDLE_VALUE = -1;

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;

const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
const FILE_SHARE_DELETE = 0x4;

const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;

const FILE_ATTRIBUTE_NORMAL = 0x80;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

const IO_REPARSE_TAG_MOUNT_POINT = 0xa0000003;
const IO_REPARSE_TAG_SYMLINK = 0xa000000c;

const FILE_FLAG_OVERLAPPED = 0x40000000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x2000000;

const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_SHARING_VIOLATION = 32;

const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;

const EINTR = 4;

class ReadStream extends stream.Readable {
    #input: InputStream | null = null;
    #readRequest: Promise<void> | null = null;

    constructor(path: string) {
        super({
            highWaterMark: 4 * 1024 * 1024
        });
        const api = getPosixApi();

        const result = api.open(Memory.allocUtf8String(path), constants.O_RDONLY, 0);

        const fd = result.value;
        if (fd === -1) {
            process.nextTick(() => {
                this.destroy(makePosixError(result.errno));
            });
            return;
        }

        this.#input = new UnixInputStream(fd, { autoClose: true });
    }

    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.#input?.close();
        this.#input = null;

        callback(error);
    }

    _read(size: number): void {
        if (this.#readRequest !== null)
            return;

        this.#readRequest = this.#input!.read(size)
            .then(buffer => {
                this.#readRequest = null;

                if (buffer.byteLength === 0) {
                    this.push(null);
                    return;
                }

                if (this.push(Buffer.from(buffer)))
                    this._read(size);
            })
            .catch(error => {
                this.#readRequest = null;
                this.destroy(error);
            });
    }
}

class WriteStream extends stream.Writable {
    #output: OutputStream | null = null;
    #writeRequest: Promise<void> | null = null;

    constructor(path: string, { flags } = {
        flags: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
    }) {
        super({
            highWaterMark: 4 * 1024 * 1024
        });
        const api = getPosixApi();

        const pathStr = Memory.allocUtf8String(path);
        const mode = constants.S_IRUSR | constants.S_IWUSR | constants.S_IRGRP | constants.S_IROTH;
        const result = api.open(pathStr, flags, mode);

        const fd = result.value;
        if (fd === -1) {
            process.nextTick(() => {
                this.destroy(makePosixError(result.errno));
            });
            return;
        }

        this.#output = new UnixOutputStream(fd, { autoClose: true });
    }

    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.#output?.close();
        this.#output = null;

        callback(error);
    }

    _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (this.#writeRequest !== null)
            return;

        this.#writeRequest = this.#output!.writeAll(chunk)
            .then(size => {
                this.#writeRequest = null;

                callback();
            })
            .catch(error => {
                this.#writeRequest = null;

                callback(error);
            });
    }
}

interface PlatformBackend {
    enumerateDirectoryEntries(path: string, callback: (entry: NativePointer) => void): void;
    readFileSync(path: string, options?: ReadFileOptions): string | Buffer;
    readlinkSync(path: string): string;
    rmdirSync(path: string): void;
    unlinkSync(path: string): void;
    statSync(path: string): Stats;
    lstatSync(path: string): Stats;
}

const posixBackend: PlatformBackend = {
    enumerateDirectoryEntries(path: string, callback: (entry: NativePointer) => void): void {
        const { opendir, opendir$INODE64, closedir, readdir, readdir$INODE64 } = getPosixApi();

        const opendirImpl = opendir$INODE64 || opendir;
        const readdirImpl = readdir$INODE64 || readdir;

        const dir = opendirImpl(Memory.allocUtf8String(path));
        const dirHandle = dir.value;
        if (dirHandle.isNull())
            throwPosixError(dir.errno);

        try {
            let entry;
            while (!((entry = readdirImpl(dirHandle)).isNull())) {
                callback(entry);
            }
        } finally {
            closedir(dirHandle);
        }
    },

    readFileSync(path: string, options: ReadFileOptions = {}): string | Buffer {
        if (typeof options === "string")
            options = { encoding: options };
        const { encoding = null } = options;

        const { open, close, lseek, read } = getPosixApi();

        const openResult = open(Memory.allocUtf8String(path), constants.O_RDONLY, 0);
        const fd = openResult.value;
        if (fd === -1)
            throwPosixError(openResult.errno);

        try {
            const fileSize = lseek(fd, 0, SEEK_END).valueOf();

            lseek(fd, 0, SEEK_SET);

            const buf = Memory.alloc(fileSize);
            let readResult, n, readFailed;
            do {
                readResult = read(fd, buf, fileSize);
                n = readResult.value.valueOf();
                readFailed = n === -1;
            } while (readFailed && readResult.errno === EINTR);

            if (readFailed)
                throwPosixError(readResult.errno);

            if (n !== fileSize.valueOf())
                throw new Error("Short read");

            return parseReadFileResult(buf, fileSize, encoding);
        } finally {
            close(fd);
        }
    },

    readlinkSync(path: string): string {
        const pathStr = Memory.allocUtf8String(path);

        const linkSize = posixBackend.lstatSync(path).size.valueOf();
        const buf = Memory.alloc(linkSize);

        const result = getPosixApi().readlink(pathStr, buf, linkSize);
        const n = result.value.valueOf();
        if (n === -1)
            throwPosixError(result.errno);

        return buf.readUtf8String(n)!;
    },

    rmdirSync(path: string): void {
        const result = getPosixApi().rmdir(Memory.allocUtf8String(path));
        if (result.value === -1)
            throwPosixError(result.errno);
    },

    unlinkSync(path: string): void {
        const result = getPosixApi().unlink(Memory.allocUtf8String(path));
        if (result.value === -1)
            throwPosixError(result.errno);
    },

    statSync(path: string): Stats {
        return performStatPosix(getStatSpec()._stat!, path);
    },

    lstatSync(path: string): Stats {
        return performStatPosix(getStatSpec()._lstat!, path);
    },
};

function writeFileSync(path: string, data: string | NodeJS.ArrayBufferView, options: WriteFileOptions = {}): void {
    if (typeof options === "string")
        options = { encoding: options };
    const { encoding = null } = options;

    let rawData: string | ArrayBuffer;
    if (typeof data === "string") {
        if (encoding !== null && !encodingIsUtf8(encoding))
            rawData = Buffer.from(data, encoding).buffer as ArrayBuffer;
        else
            rawData = data;
    } else {
        rawData = data.buffer as ArrayBuffer;
    }

    const file = new File(path, "wb");
    try {
        file.write(rawData);
    } finally {
        file.close();
    }
}

type ReadFileOptions = BufferEncoding | { encoding?: BufferEncoding; };
type WriteFileOptions = BufferEncoding | { encoding?: BufferEncoding; };

type PosixStatImpl = (path: NativePointer, buf: NativePointer) => UnixSystemFunctionResult<number>;

function performStatPosix(impl: PosixStatImpl, path: string): Stats {
    const buf = Memory.alloc(statBufSize);
    const result = impl(Memory.allocUtf8String(path), buf);
    if (result.value !== 0)
        throwPosixError(result.errno);
    return makeStatsProxy(path, buf);
}

function parseReadFileResult(buf: NativePointer, fileSize: number, encoding: BufferEncoding | null): string | Buffer {
    if (encodingIsUtf8(encoding))
        return buf.readUtf8String(fileSize)!;

    const value = Buffer.from(buf.readByteArray(fileSize)!);
    if (encoding !== null)
        return value.toString(encoding);

    return value;
}

function encodingIsUtf8(encoding: string | null): boolean {
    return encoding === "utf8" || encoding === "utf-8";
}

const backend: PlatformBackend = posixBackend;

const {
    enumerateDirectoryEntries,
    readFileSync,
    readlinkSync,
    rmdirSync,
    unlinkSync,
    statSync,
    lstatSync,
} = backend;

interface DirentSpec {
    d_name: DirentFieldSpec<string>;
    d_type: DirentFieldSpec<number>;
    atime?: DirentFieldSpec<Date>;
    mtime?: DirentFieldSpec<Date>;
    ctime?: DirentFieldSpec<Date>;
    size?: DirentFieldSpec<UInt64>;
}

type DirentFieldName = keyof DirentSpec;
type DirentExtraName = keyof Omit<DirentSpec, "d_name" | "d_type">;

type DirentFieldSpec<T> = [
    offset: number,
    read: "Utf8String" | "Utf16String" | "U8" | ((this: NativePointer, path?: string) => T)
];

const direntSpecs: { [abi: string]: DirentSpec; } = {
    "linux-32": {
        "d_name": [11, "Utf8String"],
        "d_type": [10, "U8"]
    },
    "linux-64": {
        "d_name": [19, "Utf8String"],
        "d_type": [18, "U8"]
    }
};

const direntSpec = direntSpecs[`${platform}-${pointerSize * 8}`];

function readdirSync(path: string): string[] {
    const entries: string[] = [];
    enumerateDirectoryEntries(path, entry => {
        const name = readDirentField(entry, "d_name");
        entries.push(name);
    });
    return entries;
}

function list(path: string): DirectoryEntry[] {
    const extraFieldNames = Object.keys(direntSpec).filter(k => !k.startsWith("d_")) as DirentExtraName[];

    const entries: DirectoryEntry[] = [];
    enumerateDirectoryEntries(path, entry => {
        const name = readDirentField(entry, "d_name");
        const type = readDirentField(entry, "d_type", fsPath.join(path, name));

        const extras: Partial<DirectoryEntry> = {};
        for (const f of extraFieldNames)
            extras[f] = readDirentField(entry, f);

        entries.push({
            name,
            type,
            ...extras
        });
    });
    return entries;
}

export interface DirectoryEntry {
    name: string;
    type: number;
    atime?: Date;
    mtime?: Date;
    ctime?: Date;
    size?: number;
}

function readDirentField<T>(entry: NativePointer, name: DirentFieldName, ...args: any[]) {
    const fieldSpec = direntSpec[name] as DirentFieldSpec<T>;
    const [offset, type] = fieldSpec;

    const read = (typeof type === "string") ? (NativePointer.prototype as any)["read" + type] : type;

    const value = read.call(entry.add(offset), ...args);
    if (value instanceof Int64 || value instanceof UInt64)
        return value.valueOf();

    return value;
}

interface StatSpec {
    size: number;

    fields: {
        dev: StatFieldSpec<number>;
        mode: StatFieldSpec<number>;
        nlink: StatFieldSpec<number>;
        ino: StatFieldSpec<number>;
        uid: StatFieldSpec<number>;
        gid: StatFieldSpec<number>;
        rdev: StatFieldSpec<number>;
        atime: StatFieldSpec<Date>;
        mtime: StatFieldSpec<Date>;
        ctime: StatFieldSpec<Date>;
        birthtime?: StatFieldSpec<Date>;
        size: StatFieldSpec<number | UInt64>;
        blocks: StatFieldSpec<number | UInt64>;
        blksize: StatFieldSpec<number>;
    };

    _stat?: PosixStatImpl;
    _lstat?: PosixStatImpl;
}

type StatFieldSpec<T> = [
    offset: number,
    read: "U16" | "S32" | "U32" | "S64" | "U64" | ((this: NativePointer, path: string) => T)
];

const statFields = new Set([
    "dev",
    "mode",
    "nlink",
    "uid",
    "gid",
    "rdev",
    "blksize",
    "ino",
    "size",
    "blocks",
    "atimeMs",
    "mtimeMs",
    "ctimeMs",
    "birthtimeMs",
    "atime",
    "mtime",
    "ctime",
    "birthtime",
]);
const statSpecGenericLinux32: StatSpec = {
    size: 88,
    fields: {
        "dev": [0, "U64"],
        "mode": [16, "U32"],
        "nlink": [20, "U32"],
        "ino": [12, "U32"],
        "uid": [24, "U32"],
        "gid": [28, "U32"],
        "rdev": [32, "U64"],
        "atime": [56, readTimespec32],
        "mtime": [64, readTimespec32],
        "ctime": [72, readTimespec32],
        "size": [44, "S32"],
        "blocks": [52, "S32"],
        "blksize": [48, "S32"],
    }
};
const statSpecs: { [abi: string]: StatSpec; } = {
    "linux-ia32": statSpecGenericLinux32,
    "linux-ia32-stat64": {
        size: 96,
        fields: {
            "dev": [0, "U64"],
            "mode": [16, "U32"],
            "nlink": [20, "U32"],
            "ino": [88, "U64"],
            "uid": [24, "U32"],
            "gid": [28, "U32"],
            "rdev": [32, "U64"],
            "atime": [64, readTimespec32],
            "mtime": [72, readTimespec32],
            "ctime": [80, readTimespec32],
            "size": [44, "S64"],
            "blocks": [56, "S64"],
            "blksize": [52, "S32"],
        },
    },
    "linux-x64": {
        size: 144,
        fields: {
            "dev": [0, "U64"],
            "mode": [24, "U32"],
            "nlink": [16, "U64"],
            "ino": [8, "U64"],
            "uid": [28, "U32"],
            "gid": [32, "U32"],
            "rdev": [40, "U64"],
            "atime": [72, readTimespec64],
            "mtime": [88, readTimespec64],
            "ctime": [104, readTimespec64],
            "size": [48, "S64"],
            "blocks": [64, "S64"],
            "blksize": [56, "S64"],
        },
    },
    "linux-arm": statSpecGenericLinux32,
    "linux-arm-stat64": {
        size: 104,
        fields: {
            "dev": [0, "U64"],
            "mode": [16, "U32"],
            "nlink": [20, "U32"],
            "ino": [96, "U64"],
            "uid": [24, "U32"],
            "gid": [28, "U32"],
            "rdev": [32, "U64"],
            "atime": [72, readTimespec32],
            "mtime": [80, readTimespec32],
            "ctime": [88, readTimespec32],
            "size": [48, "S64"],
            "blocks": [64, "S64"],
            "blksize": [56, "S32"],
        }
    },
    "linux-arm64": {
        size: 128,
        fields: {
            "dev": [0, "U64"],
            "mode": [16, "U32"],
            "nlink": [20, "U32"],
            "ino": [8, "U64"],
            "uid": [24, "U32"],
            "gid": [28, "U32"],
            "rdev": [32, "U64"],
            "atime": [72, readTimespec64],
            "mtime": [88, readTimespec64],
            "ctime": [104, readTimespec64],
            "size": [48, "S64"],
            "blocks": [64, "S64"],
            "blksize": [56, "S32"],
        },
    },
};
const linuxStatVersions: { [arch in Architecture]: number; } = {
    ia32: 3,
    x64: 1,
    arm: 3,
    arm64: 0,
    mips: 3,
};
const STAT_VER_LINUX = linuxStatVersions[Process.arch];
let cachedStatSpec: StatSpec | null = null;
const statBufSize = 256;

function getStatSpec(): StatSpec {
    if (cachedStatSpec !== null)
        return cachedStatSpec;

    const api = getPosixApi();
    const stat64Impl = api.stat64 ?? api.__xstat64;

    let platformId: string = `${platform}-${Process.arch}`;
    if (pointerSize === 4 && stat64Impl !== undefined) {
        platformId += "-stat64";
    }

    let statSpec = statSpecs[platformId];
    if (statSpec === undefined)
        throw new Error("Current OS/arch combo is not yet supported; please open a PR");

    statSpec._stat = stat64Impl ?? api.stat;
    statSpec._lstat = api.lstat64 ?? api.__lxstat64 ?? api.lstat;

    cachedStatSpec = statSpec;

    return statSpec;
}

class Stats {
    dev!: number;
    mode!: number;
    nlink!: number;
    uid!: number;
    gid!: number;
    rdev!: number;
    blksize!: number;
    ino!: number;
    size!: number;
    blocks!: number;
    atimeMs!: number;
    mtimeMs!: number;
    ctimeMs!: number;
    birthtimeMs!: number;
    atime!: Date;
    mtime!: Date;
    ctime!: Date;
    birthtime!: Date;

    buffer!: NativePointer;

    isFile() {
        return (this.mode & S_IFMT) === S_IFREG;
    }

    isDirectory() {
        return (this.mode & S_IFMT) === S_IFDIR;
    }

    isCharacterDevice() {
        return (this.mode & S_IFMT) === S_IFCHR;
    }

    isBlockDevice() {
        return (this.mode & S_IFMT) === S_IFBLK;
    }

    isFIFO() {
        return (this.mode & S_IFMT) === S_IFIFO;
    }

    isSymbolicLink() {
        return (this.mode & S_IFMT) === S_IFLNK;
    }

    isSocket() {
        return (this.mode & S_IFMT) === S_IFSOCK;
    }
}

function makeStatsProxy(path: string, buf: NativePointer): Stats {
    return new Proxy(new Stats(), {
        has(target, property) {
            if (typeof property === "symbol")
                return property in target;
            return statsHasField(property);
        },
        get(target, property, receiver) {
            switch (property) {
                case "prototype":
                    return undefined;
                case "constructor":
                case "toString":
                    return target[property];
                case "hasOwnProperty":
                    return statsHasField;
                case "valueOf":
                    return receiver;
                case "buffer":
                    return buf;
                default:
                    if (typeof property === "symbol" || property in target)
                        return (target as any)[property];
                    return statsReadField.call(receiver, property, path);
            }
        },
        set(target, property, value, receiver) {
            return false;
        },
        ownKeys(target) {
            return Array.from(statFields);
        },
        getOwnPropertyDescriptor(target, property) {
            return {
                writable: false,
                configurable: true,
                enumerable: true
            };
        },
    });
}

function statsHasField(name: string): boolean {
    return statFields.has(name);
}

function statsReadField<T>(this: Stats, name: string, path: string): number | UInt64 | Date | undefined {
    let field: StatFieldSpec<T> | undefined = (getStatSpec().fields as any)[name];
    if (field === undefined) {
        if (name === "birthtime") {
            return statsReadField.call(this, "ctime", path);
        }

        const msPos = name.lastIndexOf("Ms");
        if (msPos === name.length - 2) {
            return (statsReadField.call(this, name.substring(0, msPos), path) as Date).getTime();
        }

        return undefined;
    }

    const [offset, type] = field;

    const read = (typeof type === "string") ? (NativePointer.prototype as any)["read" + type] : type;

    const value = read.call(this.buffer.add(offset), path);
    if (value instanceof Int64 || value instanceof UInt64)
        return value.valueOf();

    return value;
}

function readTimespec32(this: NativePointer): Date {
    const sec = this.readU32();
    const nsec = this.add(4).readU32();
    const msec = nsec / 1000000;
    return new Date((sec * 1000) + msec);
}

function readTimespec64(this: NativePointer): Date {
    // FIXME: Improve UInt64 to support division
    const sec = this.readU64().valueOf();
    const nsec = this.add(8).readU64().valueOf();
    const msec = nsec / 1000000;
    return new Date((sec * 1000) + msec);
}

function returnZero(): number {
    return 0;
}

function returnOne(): number {
    return 1;
}

function throwPosixError(errno: number): never {
    throw makePosixError(errno);
}

function makePosixError(errno: number): Error {
    const message = getPosixApi().strerror(errno).readUtf8String()!;
    return new Error(message);
}

type AsyncCallback<T> = (error: Error | null, result?: T) => void;

function callbackify<
    F extends (...args: any[]) => any,
    P extends Parameters<F>,
    R extends ReturnType<F>
>(original: F): (...args: [...P, AsyncCallback<R>]) => void {
    return function (...args: [...P, AsyncCallback<R>]): void {
        const numArgsMinusOne = args.length - 1;

        const implArgs = args.slice(0, numArgsMinusOne);
        const callback = args[numArgsMinusOne];

        process.nextTick(function () {
            try {
                const result = original(...implArgs);
                callback(null, result);
            } catch (e) {
                callback(e as Error);
            }
        });
    };
}

const ssizeType = (pointerSize === 8) ? "int64" : "int32";
const sizeType = "u" + ssizeType;
const offsetType = pointerSize === 8 ? "int64" : "int32";

interface PosixApi {
    open(path: NativePointerValue, oflag: number, mode: number): UnixSystemFunctionResult<number>;
    close(fd: number): number;
    lseek(fd: number, offset: number | Int64, whence: number): number | Int64;
    read(fd: number, buf: NativePointerValue, count: number | UInt64): UnixSystemFunctionResult<number | Int64>;
    opendir(name: NativePointerValue): UnixSystemFunctionResult<NativePointer>;
    opendir$INODE64(name: NativePointerValue): UnixSystemFunctionResult<NativePointer>;
    closedir(dir: NativePointerValue): number;
    readdir(dir: NativePointerValue): NativePointer;
    readdir$INODE64(dir: NativePointerValue): NativePointer;
    readlink(path: NativePointerValue, buf: NativePointerValue, size: number | UInt64): UnixSystemFunctionResult<number | Int64>;
    rmdir(path: NativePointerValue): UnixSystemFunctionResult<number>;
    unlink(path: NativePointerValue): UnixSystemFunctionResult<number>;
    stat(path: NativePointerValue, buf: NativePointerValue): UnixSystemFunctionResult<number>;
    stat64(path: NativePointerValue, buf: NativePointerValue): UnixSystemFunctionResult<number>;
    __xstat64(version: number, path: NativePointerValue, buf: NativePointerValue): UnixSystemFunctionResult<number>;
    lstat(path: NativePointerValue, buf: NativePointerValue): UnixSystemFunctionResult<number>;
    lstat64(path: NativePointerValue, buf: NativePointerValue): UnixSystemFunctionResult<number>;
    __lxstat64(version: number, path: NativePointerValue, buf: NativePointerValue): UnixSystemFunctionResult<number>;
    strerror(errnum: number): NativePointer;
}

function _getPosixApi(): PosixApi {
    const SF = SystemFunction;
    const NF = NativeFunction;

    return makeApi<PosixApi>([
        ["open", SF, "int", ["pointer", "int", "...", "int"]],
        ["close", NF, "int", ["int"]],
        ["lseek", NF, offsetType, ["int", offsetType, "int"]],
        ["read", SF, ssizeType, ["int", "pointer", sizeType as NativeFunctionArgumentType]],
        ["opendir", SF, "pointer", ["pointer"]],
        ["opendir$INODE64", SF, "pointer", ["pointer"]],
        ["closedir", NF, "int", ["pointer"]],
        ["readdir", NF, "pointer", ["pointer"]],
        ["readdir$INODE64", NF, "pointer", ["pointer"]],
        ["readlink", SF, ssizeType, ["pointer", "pointer", sizeType as NativeFunctionArgumentType]],
        ["rmdir", SF, "int", ["pointer"]],
        ["unlink", SF, "int", ["pointer"]],
        ["stat", SF, "int", ["pointer", "pointer"]],
        ["stat64", SF, "int", ["pointer", "pointer"]],
        ["__xstat64", SF, "int", ["int", "pointer", "pointer"], invokeXstat],
        ["lstat", SF, "int", ["pointer", "pointer"]],
        ["lstat64", SF, "int", ["pointer", "pointer"]],
        ["__lxstat64", SF, "int", ["int", "pointer", "pointer"], invokeXstat],
        ["strerror", NF, "pointer", ["int"]],
    ]);
}

function invokeXstat(impl: any, path: string, buf: NativePointerValue): number {
    return impl(STAT_VER_LINUX, path, buf);
}

type ApiSpec = ApiSpecEntry[];
type ApiSpecEntry = DirectApiSpecEntry | WrappedApiSpecEntry;
type DirectApiSpecEntry = [
    name: string,
    ctor: SystemFunctionConstructor | NativeFunctionConstructor,
    retType: NativeFunctionReturnType,
    argTypes: NativeFunctionArgumentType[]
];
type WrappedApiSpecEntry = [
    name: string,
    ctor: SystemFunctionConstructor | NativeFunctionConstructor,
    retType: NativeFunctionReturnType,
    argTypes: NativeFunctionArgumentType[],
    wrapper: (...args: any[]) => any,
];

function makeApi<T>(spec: ApiSpec): T {
    return spec.reduce((api, entry) => {
        addApiPlaceholder(api, entry);
        return api;
    }, {} as T);
}

const nativeOpts: NativeFunctionOptions = {};

function addApiPlaceholder<T>(api: T, entry: ApiSpecEntry): void {
    const [name] = entry;
    Object.defineProperty(api, name, {
        configurable: true,
        get() {
            const [, Ctor, retType, argTypes, wrapper] = entry;

            let impl = null;
            const address = Module.findExportByName(null, name);
            if (address !== null)
                impl = new Ctor(address, retType, argTypes, nativeOpts);

            if (wrapper !== undefined)
                impl = wrapper.bind(null, impl);

            Object.defineProperty(api, name, { value: impl });

            return impl;
        }
    });
}

export function createReadStream(path: string): ReadStream {
    return new ReadStream(path);
}

export function createWriteStream(path: string): WriteStream {
    return new WriteStream(path);
}

export const readdir = callbackify(readdirSync);
export const readFile = callbackify(readFileSync);
export const writeFile = callbackify(writeFileSync);
export const readlink = callbackify(readlinkSync);
export const rmdir = callbackify(rmdirSync);
export const unlink = callbackify(unlinkSync);
export const stat = callbackify(statSync);
export const lstat = callbackify(lstatSync);

function memoize<T>(compute: Compute<T>): Compute<T> {
    let value: T;
    let computed = false;

    return function (...args) {
        if (!computed) {
            value = compute(...args);
            computed = true;
        }

        return value;
    };
}

type Compute<T> = (...args: any[]) => T;

export {
    constants,
    readdirSync,
    list,
    readFileSync,
    writeFileSync,
    readlinkSync,
    rmdirSync,
    unlinkSync,
    statSync,
    lstatSync,
    Stats,
};

export default {
    constants,
    createReadStream,
    createWriteStream,
    readdir,
    readdirSync,
    list,
    readFile,
    readFileSync,
    writeFile,
    writeFileSync,
    readlink,
    readlinkSync,
    rmdir,
    rmdirSync,
    unlink,
    unlinkSync,
    stat,
    statSync,
    lstat,
    lstatSync,
    Stats,
};
