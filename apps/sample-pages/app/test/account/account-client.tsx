"use client";

import { useState } from "react";

const tabStyle = (selected: boolean) =>
    ({
        padding: "8px 16px",
        border: "1px solid #d0d7de",
        borderBottom: selected ? "2px solid #1f6feb" : "1px solid #d0d7de",
        background: selected ? "#ffffff" : "#f6f8fa",
        font: "inherit",
        cursor: "pointer",
    }) as const;

/**
 * The signed-in part of the account fixture: two tabs, and a Monthly / Annual
 * switch inside Billing. Everything a Macro has to do to reach the annual
 * price is here: open the billing tab, then switch to Annual.
 */
export function AccountClient({
    billingLabel,
    annualPrice,
}: {
    billingLabel: string;
    annualPrice: string;
}) {
    const [tab, setTab] = useState<"overview" | "billing">("overview");
    const [period, setPeriod] = useState<"monthly" | "annual">("monthly");

    return (
        <div>
            <div
                role="tablist"
                aria-label="Account"
                style={{ display: "flex", gap: 8 }}>
                <button
                    role="tab"
                    aria-selected={tab === "overview"}
                    onClick={() => setTab("overview")}
                    style={tabStyle(tab === "overview")}>
                    Overview
                </button>
                <button
                    role="tab"
                    aria-selected={tab === "billing"}
                    onClick={() => setTab("billing")}
                    style={tabStyle(tab === "billing")}>
                    {billingLabel}
                </button>
            </div>

            {tab === "overview" ?
                <section id="overview" style={{ padding: "16px 0" }}>
                    <h2 style={{ fontSize: 22, margin: "0 0 12px" }}>
                        Overview
                    </h2>
                    <p style={{ margin: 0 }}>
                        6 dashboards, 20 reports, 7 teammates.
                    </p>
                </section>
            :   <section id="billing" style={{ padding: "16px 0" }}>
                    <h2 style={{ fontSize: 22, margin: "0 0 12px" }}>
                        Your plan
                    </h2>
                    <div
                        role="group"
                        aria-label="Billing period"
                        style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                        <button
                            aria-pressed={period === "monthly"}
                            onClick={() => setPeriod("monthly")}
                            style={tabStyle(period === "monthly")}>
                            Monthly
                        </button>
                        <button
                            aria-pressed={period === "annual"}
                            onClick={() => setPeriod("annual")}
                            style={tabStyle(period === "annual")}>
                            Annual
                        </button>
                    </div>
                    <p
                        id="plan-price"
                        style={{ margin: "0 0 8px", fontSize: 20 }}>
                        {period === "monthly" ?
                            "Team plan: $99 per month, billed monthly."
                        :   `Team plan: ${annualPrice} per year, billed annually.`
                        }
                    </p>
                    <p style={{ margin: 0, color: "#57606a" }}>
                        Next invoice on the 1st. Ten seats included.
                    </p>
                </section>
            }
        </div>
    );
}
