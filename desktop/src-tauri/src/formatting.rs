pub fn tokens(value: Option<i64>) -> String {
    abbreviate(value, true)
}

pub fn count(value: Option<i64>) -> String {
    abbreviate(value, false)
}

pub fn cost(value: Option<f64>) -> String {
    let Some(value) = value else {
        return "—".into();
    };
    if value < 1_000.0 {
        return format!("${value:.2}");
    }
    format!("${}", abbreviate_float(value, false))
}

fn abbreviate(value: Option<i64>, integer: bool) -> String {
    let Some(value) = value else {
        return "—".into();
    };
    if !integer && value < 10_000 {
        return format!("{value}");
    }
    if integer && value < 1_000 {
        return format!("{value}");
    }
    abbreviate_float(value as f64, integer)
}

fn abbreviate_float(value: f64, integer: bool) -> String {
    let units = [
        (1_000_000_000_000.0, "T"),
        (1_000_000_000.0, "B"),
        (1_000_000.0, "M"),
        (1_000.0, "K"),
    ];
    for (threshold, suffix) in units {
        if value >= threshold * 0.9995 {
            let scaled = value / threshold;
            let decimals = if integer || scaled >= 100.0 {
                0
            } else if scaled >= 10.0 {
                1
            } else {
                2
            };
            let rendered = format!("{scaled:.decimals$}");
            let rendered = if rendered.contains('.') {
                rendered.trim_end_matches('0').trim_end_matches('.')
            } else {
                &rendered
            };
            return format!("{rendered}{suffix}");
        }
    }
    format!("{value:.0}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_boundaries_match_swift_formatting() {
        assert_eq!(tokens(Some(999_600)), "1M");
        assert_eq!(tokens(Some(1_234)), "1K");
        assert_eq!(tokens(Some(2_401_634_303)), "2B");
        assert_eq!(tokens(None), "—");
    }

    #[test]
    fn counts_and_costs_have_expected_precision() {
        assert_eq!(count(Some(9_999)), "9999");
        assert_eq!(count(Some(12_345)), "12.3K");
        assert_eq!(cost(Some(12.345)), "$12.35");
        assert_eq!(cost(Some(1_234.0)), "$1.23K");
    }

    #[test]
    fn abbreviations_preserve_integer_trailing_zeros() {
        for (unit, suffix) in [
            (1_000, "K"),
            (1_000_000, "M"),
            (1_000_000_000, "B"),
            (1_000_000_000_000, "T"),
        ] {
            for multiple in [10, 100, 110] {
                let value = unit * multiple;
                let expected = format!("{multiple}{suffix}");
                assert_eq!(tokens(Some(value)), expected);
                assert_eq!(count(Some(value)), expected);
                assert_eq!(cost(Some(value as f64)), format!("${expected}"));
            }
        }
        assert_eq!(tokens(Some(9_600_000)), "10M");
        assert_eq!(count(Some(99_960_000)), "100M");
    }

    #[test]
    fn fractional_trailing_zeros_are_still_trimmed() {
        assert_eq!(count(Some(1_000_000)), "1M");
        assert_eq!(count(Some(1_200_000)), "1.2M");
        assert_eq!(count(Some(1_234_000)), "1.23M");
        assert_eq!(count(Some(12_340_000)), "12.3M");
        assert_eq!(cost(Some(1_200.0)), "$1.2K");
    }
}
