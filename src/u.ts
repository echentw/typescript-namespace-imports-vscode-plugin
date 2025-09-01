import * as pathUtil from 'path';

export type Result<OkT, ErrT> = ResultOk<OkT> | ResultErr<ErrT>;
export const Result = {
    ok: <OkT>(value: OkT) => new ResultOk(value),
    err: <ErrT>(err: ErrT) => new ResultErr(err),
};

class ResultOk<OkT> {
    public readonly ok = true;
    constructor(public readonly value: OkT) {}

    mapOk = <OkU>(fn: (value: OkT) => OkU): ResultOk<OkU> => {
        return Result.ok(fn(this.value));
    };

    mapErr = <ErrU>(fn: (err: never) => ErrU): ResultOk<OkT> => {
        return this;
    };
}

class ResultErr<ErrT> {
    public readonly ok = false;
    constructor(public readonly err: ErrT) {}

    mapOk = <OkU>(fn: (value: never) => OkU): ResultErr<ErrT> => {
        return this;
    };

    mapErr = <ErrU>(fn: (err: ErrT) => ErrU): ResultErr<ErrU> => {
        return Result.err(fn(this.err));
    };
}

export function q(s: string): string {
    return JSON.stringify(s);
}

export function fireAndForget(fnAsync: () => Promise<void>): void {
    fnAsync();
}

export function firstChar(value: string): string {
    return value.slice(0, 1);
}

export function stringify(obj: unknown): string {
    return JSON.stringify(obj, mapReplacer, 4);

    function mapReplacer(key: string, value: unknown) {
        if (value instanceof Map) {
            return Object.fromEntries(value);
        }
        return value;
    }
}

export function assert(value: boolean, msg?: string): asserts value {
    if (!value) {
        if (msg === undefined) {
            throw new Error('assert failed');
        } else {
            throw new Error(`assert failed: ${msg}`);
        }
    }
}

export function impossible(value: never): never {
    throw new Error(`impossible according to static types: ${value}`);
}

export function max<T>(items: Array<T>, compareFn: cmp.CompareFn<T>): T {
    assert(items.length > 0);
    let current = items[0];
    for (let i = 1; i < items.length; i++) {
        if (compareFn(current, items[i]) < 0) {
            current = items[i];
        }
    }
    return current;
}

export function sort<T>(items: Array<T>, compareFn: cmp.CompareFn<T>): Array<T> {
    return items.slice().sort(compareFn);
}

export function pathWithoutExt(path: string): string {
    return path.slice(0, path.length - pathUtil.extname(path).length);
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace iter {
    export function filter<T>(it: Iterable<T>, predicateFn: (value: T) => boolean): Array<T> {
        const ret: Array<T> = [];
        for (const value of it) {
            if (predicateFn(value)) {
                ret.push(value);
            }
        }
        return ret;
    }

    export function some<T>(it: Iterable<T>, predicateFn: (value: T) => boolean): boolean {
        for (const value of it) {
            if (predicateFn(value)) {
                return true;
            }
        }
        return false;
    }
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace map {
    export function getOrCreate<K, V>(map: Map<K, V>, key: K, makeValue: () => V): V {
        const value = map.get(key);
        if (value === undefined) {
            const value = makeValue();
            map.set(key, value);
            return value;
        }
        return value;
    }

    export function getOrThrow<K, V>(map: Map<K, V>, k: K): V {
        const v = map.get(k);
        assert(v !== undefined);
        return v;
    }

    export function fromEntries<K, V>(entries: Iterable<[K, V]>): Map<K, V> {
        return new Map(entries);
    }
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace cmp {
    export type CompareFn<T> = (a: T, b: T) => number;

    export function number(a: number, b: number): number {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    }

    export function transform<InT, OutT>(transformFn: (value: InT) => OutT, cmpFn: CompareFn<OutT>): CompareFn<InT> {
        return (inA, inB) => {
            const outA = transformFn(inA);
            const outB = transformFn(inB);
            return cmpFn(outA, outB);
        };
    }
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace parse {
    type Parser<InT, OutT> = (input: InT) => Result<OutT, string>;

    export namespace string {
        export namespace to {
            export function literalUnion<const T extends Array<string>>(values: T): Parser<string, T[number]> {
                return input => {
                    const value = values.find(v => v === input);
                    if (value === undefined) {
                        return Result.err(`Expected one of [${values.map(q).join(',')}]. Got: ${q(input)}.`);
                    }
                    return Result.ok(value);
                };
            }
        }
    }
}