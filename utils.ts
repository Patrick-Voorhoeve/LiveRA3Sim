export type Tuple<T, N extends number> = N extends N ? number extends N ? T[] : _TupleOf<T, N, []> : never;
type _TupleOf<T, N extends number, R extends unknown[]> = R['length'] extends N ? R : _TupleOf<T, N, [T, ...R]>;


export const timer = (ms: number) => new Promise(res => setTimeout(res, ms));

/** Applies a high pass filter to an N length array of M channels */
export function highPass(buffer: number[][], cutoffFrequency: number, sampleRate: number): number[][] {
    const RC                        = 1 / (2 * Math.PI * cutoffFrequency);
    const dt                        = 1 / sampleRate;
    const alpha                     = RC / (RC + dt);
    const numChannels               = buffer.length;
    const numSamples                = buffer[0].length;
    const filteredBuffer            = [] as number[][];    

    for (let ch = 0; ch < numChannels; ch++) {
        const filteredColumn        = [ buffer[ch][0] ] as number[];

        for (let row = 1; row < numSamples; row++) {
            const filteredValue = alpha * (filteredColumn[row - 1] + buffer[ch][row] - buffer[ch][row - 1]);
            filteredColumn.push(filteredValue); 
        }        

        filteredBuffer.push(filteredColumn);
    }

    return filteredBuffer;
}

/** Returns the standard deviation of a channel */
export function std(channel: number[]) {
    const n     = channel.length
    const mean  = channel.reduce((a, b) => a + b) / n
    return Math.sqrt(channel.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n);
}
  