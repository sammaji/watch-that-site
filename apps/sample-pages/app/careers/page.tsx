import { getJobPosts } from "@/lib/faker";
import { careersPageParams, type SearchParams } from "@/lib/refresh-params";
import { CareersClient } from "./careers-client";

export const dynamic = "force-dynamic";

type CareerPageProps = { searchParams: SearchParams };

export default async function CareersPage({ searchParams }: CareerPageProps) {
    const { titleRefreshInterval } = await careersPageParams(searchParams);
    return <CareersClient jobs={getJobPosts(titleRefreshInterval)} />;
}
