export type Clock = () => number;

export const systemClock: Clock = Date.now;
