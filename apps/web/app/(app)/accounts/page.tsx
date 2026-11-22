import { DeleteAccountConfirmationModal } from "@/components/accounts/delete-account-confirmation-modal";
import { EditProfile } from "@/components/accounts/edit-profile";
import { SessionsList } from "@/components/accounts/sessions-list";
import { UtilityModel } from "@/components/accounts/utility-model";
import {
    Card,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@watchthatsite/ui/components/card";
import { Separator } from "@watchthatsite/ui/components/separator";

export default function AccountPage() {
    return (
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 p-4 py-8 md:grid-cols-2">
            <div>
                <h3>Profile</h3>
            </div>
            <EditProfile />
            <Separator className="col-span-2 my-4" />

            <div className="space-y-1">
                <h3>Utility model</h3>
                <p className="text-muted-foreground text-sm">
                    Suggests what to watch when you add a page. Monitors
                    themselves use the model chosen on each one.
                </p>
            </div>
            <UtilityModel />
            <Separator className="col-span-2 my-4" />

            <div className="col-span-2">
                <SessionsList />
            </div>

            <Separator className="col-span-2 my-4" />

            <Card className="bg-destructive/10 border-destructive/25 col-span-2">
                <CardHeader className="border-destructive/25">
                    <CardTitle className="font-normal">
                        Delete account
                    </CardTitle>
                    <CardDescription>
                        Deletes your account and everything in it. This{" "}
                        <span className="text-destructive">
                            cannot be undone
                        </span>
                        .
                    </CardDescription>
                </CardHeader>
                <CardFooter className="flex justify-end">
                    <DeleteAccountConfirmationModal />
                </CardFooter>
            </Card>
        </div>
    );
}
