import { OgImage } from "@/components/og-image";
import { getPageImage, source } from "@/lib/source";
import { ImageResponse } from "@takumi-rs/image-response";
import { notFound } from "next/navigation";

export const revalidate = false;

export async function GET(
    _req: Request,
    { params }: RouteContext<"/og/[...slug]">,
) {
    const { slug } = await params;
    const page = source.getPage(slug.slice(0, -1));
    if (!page) notFound();

    return new ImageResponse(
        <OgImage title={page.data.title} description={page.data.description} />,
        {
            width: 1280,
            height: 640,
            format: "webp",
        },
    );
}

export function generateStaticParams() {
    return source.getPages().map(page => ({
        lang: page.locale,
        slug: getPageImage(page).segments,
    }));
}
