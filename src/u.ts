export type Result<OkT, ErrT> = ResultOk<OkT> | ResultErr<ErrT>;
export const Result = {
    ok: <OkT>(value: OkT) => new ResultOk(value),
    err: <ErrT>(err: ErrT) => new ResultErr(err),
};

class ResultOk<T> {
    public readonly ok = true;
    constructor(public readonly value: T) {}
}

class ResultErr<ErrT> {
    public readonly ok = false;
    constructor(public readonly err: ErrT) {}
}

export function fireAndForget(fnAsync: () => Promise<void>): void {
    fnAsync();
}

export function getOrCreate<K, V>(map: Map<K, V>, key: K, makeValue: () => V): V {
    const value = map.get(key);
    if (value === undefined) {
        const value = makeValue();
        map.set(key, value);
        return value;
    }
    return value;
}

export function firstChar(value: string): string {
    return value.slice(0, 1);
}