export const name = "image";

export const width = 1280;
export const height = 640;

export const fonts = ["geist/Geist[wght].woff2"];

function GlobeIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ff3535"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
            <path d="M2 12h20" />
        </svg>
    );
}

export function OgImage({
    title,
    description,
}: {
    title: string;
    description: string | undefined;
}) {
    return (
        <div
            style={{
                backgroundColor: "#fcfcfc",
                backgroundImage:
                    "radial-gradient(#e5e5e5 1px, transparent 1px)",
                backgroundSize: "32px 32px",
                width: "100%",
                height: "100%",
                fontFamily: "Geist, sans-serif",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#171717",
                position: "relative",
                padding: "4rem",
            }}>
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    alignItems: "flex-start",
                    width: "100%",
                    maxWidth: "1000px",
                    position: "relative",
                    zIndex: 1,
                }}>
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "1.5rem",
                        marginBottom: "2.5rem",
                    }}>
                    <h1
                        style={{
                            fontSize: "6.5rem",
                            fontWeight: 800,
                            margin: 0,
                            letterSpacing: "-0.04em",
                            lineHeight: 1,
                            color: "#111111",
                        }}>
                        {title}
                    </h1>
                </div>

                <p
                    style={{
                        fontSize: "2.5rem",
                        fontWeight: 400,
                        color: "#4a4a4a",
                        maxWidth: "920px",
                        margin: 0,
                        marginBottom: "4rem",
                        lineHeight: 1.35,
                        letterSpacing: "-0.015em",
                    }}>
                    {description}
                </p>

                <div
                    style={{
                        display: "flex",
                        gap: "2.5rem",
                        alignItems: "center",
                        color: "#555555",
                        fontSize: "1.25rem",
                        fontWeight: 600,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                    }}>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.75rem",
                        }}>
                        <GlobeIcon />
                        <span>WatchThatSite</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
