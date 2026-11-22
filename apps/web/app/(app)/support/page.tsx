import { EmptyPage } from "@/components/app/empty-page";
import { BadgeHelp } from "lucide-react";

export default function SupportPage() {
    return (
        <EmptyPage
            icon={BadgeHelp}
            eyebrow="Support"
            title="Support"
            description="Support resources and contact options will live here."
        />
    );
}
