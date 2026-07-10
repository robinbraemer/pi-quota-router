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
