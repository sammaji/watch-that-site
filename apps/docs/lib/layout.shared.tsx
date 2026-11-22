import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Globe } from "lucide-react";
import { appName } from "./shared";

export function baseOptions(): BaseLayoutProps {
    return {
        nav: {
            title: appName,
            url: "https://wts.sammaji.com",
        },
        links: [
            {
                type: "button",
                text: "WatchThatSite",
                url: "https://wts.sammaji.com",
                icon: <Globe />,
            },
        ],
    };
}
