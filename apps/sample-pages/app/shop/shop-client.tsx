"use client";

import { Button } from "@watchthatsite/ui/components/button";
import {
    Sheet,
    SheetContent,
    SheetFooter,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from "@watchthatsite/ui/components/sheet";
import { ShoppingCartIcon } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

import type { Product } from "@/lib/faker";

type ProductWithPrice = Product & { price: number };

export function ShopClient({
    products,
    checkoutDisabled,
    now,
}: {
    products: ProductWithPrice[];
    checkoutDisabled: boolean;
    now: number;
}) {
    const [cart, setCart] = useState<Record<string, number>>({});

    const cartItems = Object.entries(cart)
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => ({
            product: products.find((p) => p.id === id)!,
            qty,
        }));

    const cartCount = cartItems.reduce((sum, item) => sum + item.qty, 0);
    const cartTotal = cartItems.reduce(
        (sum, item) => sum + item.qty * item.product.price,
        0,
    );

    function addToCart(productId: string) {
        setCart((prev) => ({ ...prev, [productId]: (prev[productId] ?? 0) + 1 }));
    }

    return (
        <main className="mx-auto max-w-4xl space-y-6 p-8">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-semibold">Shop</h1>
                <p className="text-sm text-gray-500" data-testid="current-time">
                    {new Date(now).toISOString()}
                </p>
                <Sheet>
                    <SheetTrigger asChild>
                        <Button data-testid="cart-trigger">
                            <ShoppingCartIcon />
                            Cart ({cartCount})
                        </Button>
                    </SheetTrigger>
                    <SheetContent data-testid="cart-sheet">
                        <SheetHeader>
                            <SheetTitle>Your Cart</SheetTitle>
                        </SheetHeader>
                        <div className="flex-1 space-y-3 overflow-y-auto px-4">
                            {cartItems.length === 0 && (
                                <p className="text-sm text-gray-500">Cart is empty.</p>
                            )}
                            {cartItems.map(({ product, qty }) => (
                                <div
                                    key={product.id}
                                    className="flex items-center justify-between text-sm">
                                    <span>
                                        {product.name} x{qty}
                                    </span>
                                    <span>${(product.price * qty).toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                        <SheetFooter>
                            <div
                                className="flex items-center justify-between font-medium"
                                data-testid="cart-total">
                                <span>Total</span>
                                <span>${cartTotal.toFixed(2)}</span>
                            </div>
                            <Button disabled={checkoutDisabled} data-testid="checkout-button">
                                Checkout
                            </Button>
                        </SheetFooter>
                    </SheetContent>
                </Sheet>
            </div>

            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {products.map((product) => (
                    <div
                        key={product.id}
                        data-testid="product-card"
                        className="space-y-2 rounded-lg border p-4">
                        <Image
                            src={product.image}
                            alt={product.name}
                            width={400}
                            height={300}
                            className="w-full rounded-md object-cover"
                        />
                        <h2 className="font-medium">{product.name}</h2>
                        <p className="text-sm text-gray-500">{product.description}</p>
                        <p className="text-sm" data-testid="product-units">
                            {product.units} in stock
                        </p>
                        <p className="font-semibold" data-testid="product-price">
                            ${product.price.toFixed(2)}
                        </p>
                        <Button
                            className="w-full"
                            onClick={() => addToCart(product.id)}
                            data-testid="add-to-cart">
                            Add to cart
                        </Button>
                        <div className="space-y-1 pt-2">
                            {product.comments.map((comment, i) => (
                                <p key={i} className="text-xs text-gray-500">
                                    “{comment}”
                                </p>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </main>
    );
}
