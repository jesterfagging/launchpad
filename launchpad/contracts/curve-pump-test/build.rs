use std::str::FromStr;
fn main() {
    println!("cargo:rerun-if-env-changed=LAUNCHPAD_TEST_OPERATOR");
    if std::env::var_os("CARGO_FEATURE_OWNER_TEST").is_some() {
        let operator = std::env::var("LAUNCHPAD_TEST_OPERATOR")
            .expect("owner-test requires the owner's explicit public key in LAUNCHPAD_TEST_OPERATOR");
        let key = solana_pubkey::Pubkey::from_str(&operator).expect("invalid owner public key");
        assert!(key.is_on_curve(), "owner must be a wallet key, not a PDA");
        let fixtures = [
            "CJfRUQxyonG6B5mnztsNUqxknbFT89DJdrdrzV9F96mU",
            "CnEDk9HrMnmiHXEV1WFgbVCRteYnPqsJwrTdcZaNhFVW",
            "46Kq4hASUdvUbwR7s7Pie3x8f4HRB3NLay7Z9jh9eZsB",
            "FixSiDfTxvoy5Zgjp5KdFU8U23ChwCxPWY3WTkmMW2fU",
            "7e5pxK83ceXb2iWXBizF1U8MdL7C5VcVBBXpDWaYo3x1",
        ];
        assert!(
            !fixtures.contains(&operator.as_str()),
            "public fixture keys cannot compile owner-test"
        );
        assert!(
            (32..=44).contains(&operator.len())
                && operator.bytes().all(|c| {
                    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&c)
                }),
            "owner public key must be base58"
        );
    }
}
