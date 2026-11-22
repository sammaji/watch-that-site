"use client";

import { CATEGORIES, JobPost } from "@/lib/faker";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@watchthatsite/ui/components/select";
import { useMemo, useState } from "react";

const ALL = "all";

export function CareersClient({ jobs }: { jobs: JobPost[] }) {
    // Filter state is local-only by design, not synced to the URL/query params.
    const [category, setCategory] = useState<string>(ALL);
    const filteredJobs = useMemo(
        () =>
            category === ALL ? jobs : (
                jobs.filter(job => job.category === category)
            ),
        [jobs, category],
    );

    return (
        <main className="mx-auto max-w-3xl space-y-6 p-8">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-semibold">Careers</h1>
                <p className="text-sm text-gray-500" data-testid="current-time">
                    {new Date().toISOString()}
                </p>
            </div>

            <Select value={category} onValueChange={setCategory}>
                <SelectTrigger data-testid="category-filter">
                    <SelectValue placeholder="Filter by category" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value={ALL}>All categories</SelectItem>
                    {CATEGORIES.map(cat => (
                        <SelectItem key={cat} value={cat}>
                            {cat}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            <ul className="space-y-3">
                {filteredJobs.map(job => (
                    <li
                        key={job.id}
                        data-testid="job-listing"
                        className="space-y-1 rounded-lg border p-4">
                        <div className="flex items-center justify-between">
                            <h2 className="font-medium" data-testid="job-title">
                                {job.title}
                            </h2>
                            <span className="text-xs text-gray-500">
                                {job.category}
                            </span>
                        </div>
                        <p className="text-sm text-gray-500">{job.location}</p>
                        <p className="text-sm">{job.description}</p>
                    </li>
                ))}
            </ul>
        </main>
    );
}
