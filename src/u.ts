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