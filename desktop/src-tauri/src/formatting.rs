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
            return format!(
                "{}{}",
                rendered.trim_end_matches('0').trim_end_matches('.'),
                suffix
            );
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
}
