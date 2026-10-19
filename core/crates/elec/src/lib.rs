//! DC/transient circuit solver (P1-01), servo dynamics (P1-03) and dev-board power model (P1-02).
//! No third-party deps; advances on simulated time so results are deterministic.
pub mod board;
pub mod fault;
pub mod i2cbus;
pub mod mna;
pub mod servo;
pub mod spice;
