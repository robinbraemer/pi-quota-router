export const completeUsageResponse = {
  plan_type: "pro",
  rate_limit: {
    primary_window: {
      used_percent: 12.5,
      reset_at: 2_000_000_100,
    },
    secondary_window: {
      used_percent: 37,
      reset_at: 2_000_604_800_000,
    },
  },
  credits: {
    balance: 42,
  },
};

export const primaryOnlyUsageResponse = {
  rate_limit: {
    primary_window: {
      used_percent: 0,
      reset_at: 2_000_000_100,
    },
  },
};

export const weeklyOnlyPrimaryUsageResponse = {
  plan_type: "pro",
  rate_limit: {
    primary_window: {
      used_percent: 3,
      reset_at: 2_000_604_800,
      limit_window_seconds: 604_800,
    },
  },
};

export const reversedDurationUsageResponse = {
  rate_limit: {
    primary_window: {
      used_percent: 30,
      reset_at: 2_000_604_800,
      limit_window_seconds: 604_800,
    },
    secondary_window: {
      used_percent: 10,
      reset_at: 2_000_018_000,
      limit_window_seconds: 18_000,
    },
  },
};
