"use client";

import { DEPARTMENTS, type Department, type Role } from "@/lib/careers";
import { useState } from "react";

export function CareersBoard({ roles }: { roles: Role[] }) {
    const [department, setDepartment] = useState<Department | "All">("All");
    const shown =
        department === "All" ? roles : (
            roles.filter(r => r.department === department)
        );

    return (
        <main className="mx-auto max-w-3xl px-6 py-14 font-sans text-neutral-900">
            <p className="text-sm font-medium text-indigo-600">
                Northwind Analytics
            </p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight">
                Join us
            </h1>
            <p className="mt-3 max-w-xl text-neutral-600">
                We build analytics people actually read. Small teams, real
                ownership, remote-friendly.
            </p>

            <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 pb-4">
                <h2 className="text-lg font-semibold">
                    Open roles{" "}
                    <span className="text-neutral-400">({shown.length})</span>
                </h2>
                <label className="flex items-center gap-2 text-sm text-neutral-600">
                    Department
                    <select
                        aria-label="Department"
                        value={department}
                        onChange={e =>
                            setDepartment(e.target.value as Department | "All")
                        }
                        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-900">
                        <option value="All">All departments</option>
                        {DEPARTMENTS.map(d => (
                            <option key={d} value={d}>
                                {d}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            <ul className="divide-y divide-neutral-200">
                {shown.map(role => (
                    <li
                        key={role.id}
                        className="flex flex-wrap items-baseline justify-between gap-2 py-4">
                        <div>
                            <p className="font-medium">{role.title}</p>
                            <p className="text-sm text-neutral-500">
                                {role.department} · {role.location}
                            </p>
                        </div>
                        <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs text-neutral-600">
                            {role.type}
                        </span>
                    </li>
                ))}
                {shown.length === 0 ?
                    <li className="py-8 text-center text-sm text-neutral-500">
                        No open roles in {department} right now.
                    </li>
                :   null}
            </ul>
            <p className="mt-8 text-xs text-neutral-400">
                Northwind Analytics Ltd. Equal opportunity employer.
            </p>
        </main>
    );
}
