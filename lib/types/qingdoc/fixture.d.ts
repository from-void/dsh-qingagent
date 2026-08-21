/** 第一阶段固定验收稿：覆盖青简正文岛的主要结构节点与行内 marks。 */
export declare const QINGDOC_FIXTURE_PM_DOC: {
    type: "doc";
    attrs: {
        schemaVersion: 1;
    };
    content: ({
        type: string;
        attrs: {
            blockId: string;
            level: number;
            anchor: string;
            emoji?: undefined;
            tone?: undefined;
            language?: undefined;
        };
        content: {
            type: string;
            text: string;
        }[];
    } | {
        type: string;
        attrs: {
            blockId: string;
            level?: undefined;
            anchor?: undefined;
            emoji?: undefined;
            tone?: undefined;
            language?: undefined;
        };
        content: ({
            type: string;
            text: string;
            marks?: undefined;
            attrs?: undefined;
        } | {
            type: string;
            text: string;
            marks: {
                type: string;
            }[];
            attrs?: undefined;
        } | {
            type: string;
            text: string;
            marks: {
                type: string;
                attrs: {
                    color: string;
                };
            }[];
            attrs?: undefined;
        } | {
            type: string;
            attrs: {
                latex: string;
            };
            text?: undefined;
            marks?: undefined;
        })[];
    } | {
        type: string;
        attrs: {
            blockId: string;
            level?: undefined;
            anchor?: undefined;
            emoji?: undefined;
            tone?: undefined;
            language?: undefined;
        };
        content: {
            type: string;
            attrs: {
                blockId: string;
            };
            content: ({
                type: string;
                attrs: {
                    blockId: string;
                };
                content: {
                    type: string;
                    text: string;
                }[];
            } | {
                type: string;
                attrs: {
                    blockId: string;
                };
                content: {
                    type: string;
                    attrs: {
                        blockId: string;
                    };
                    content: {
                        type: string;
                        attrs: {
                            blockId: string;
                        };
                        content: {
                            type: string;
                            text: string;
                        }[];
                    }[];
                }[];
            })[];
        }[];
    } | {
        type: string;
        attrs: {
            blockId: string;
            level?: undefined;
            anchor?: undefined;
            emoji?: undefined;
            tone?: undefined;
            language?: undefined;
        };
        content: {
            type: string;
            attrs: {
                blockId: string;
                checked: boolean;
            };
            content: {
                type: string;
                attrs: {
                    blockId: string;
                };
                content: {
                    type: string;
                    text: string;
                }[];
            }[];
        }[];
    } | {
        type: string;
        attrs: {
            blockId: string;
            emoji: string;
            tone: string;
            level?: undefined;
            anchor?: undefined;
            language?: undefined;
        };
        content: {
            type: string;
            attrs: {
                blockId: string;
            };
            content: {
                type: string;
                text: string;
            }[];
        }[];
    } | {
        type: string;
        attrs: {
            blockId: string;
            level?: undefined;
            anchor?: undefined;
            emoji?: undefined;
            tone?: undefined;
            language?: undefined;
        };
        content: ({
            type: string;
            content: {
                type: string;
                attrs: {
                    backgroundColor: string;
                };
                content: {
                    type: string;
                    attrs: {
                        blockId: string;
                    };
                    content: {
                        type: string;
                        text: string;
                        marks: {
                            type: string;
                        }[];
                    }[];
                }[];
            }[];
        } | {
            type: string;
            content: {
                type: string;
                attrs: {
                    backgroundColor: string;
                };
                content: {
                    type: string;
                    attrs: {
                        blockId: string;
                    };
                    content: {
                        type: string;
                        text: string;
                    }[];
                }[];
            }[];
        })[];
    } | {
        type: string;
        attrs: {
            blockId: string;
            level?: undefined;
            anchor?: undefined;
            emoji?: undefined;
            tone?: undefined;
            language?: undefined;
        };
        content: ({
            type: string;
            attrs: {
                blockId: string;
                widthRatio: number;
            };
            content: {
                type: string;
                attrs: {
                    blockId: string;
                };
                content: {
                    type: string;
                    text: string;
                    marks: {
                        type: string;
                    }[];
                }[];
            }[];
        } | {
            type: string;
            attrs: {
                blockId: string;
                widthRatio: number;
            };
            content: {
                type: string;
                attrs: {
                    blockId: string;
                };
                content: {
                    type: string;
                    text: string;
                }[];
            }[];
        })[];
    } | {
        type: string;
        attrs: {
            blockId: string;
            language: string;
            level?: undefined;
            anchor?: undefined;
            emoji?: undefined;
            tone?: undefined;
        };
        content: {
            type: string;
            text: string;
        }[];
    })[];
};
export declare const QINGDOC_FIXTURE_SNAPSHOT: {
    version: number;
    ts: string;
    sections: never[];
    pmDoc: {
        type: "doc";
        attrs: {
            schemaVersion: 1;
        };
        content: ({
            type: string;
            attrs: {
                blockId: string;
                level: number;
                anchor: string;
                emoji?: undefined;
                tone?: undefined;
                language?: undefined;
            };
            content: {
                type: string;
                text: string;
            }[];
        } | {
            type: string;
            attrs: {
                blockId: string;
                level?: undefined;
                anchor?: undefined;
                emoji?: undefined;
                tone?: undefined;
                language?: undefined;
            };
            content: ({
                type: string;
                text: string;
                marks?: undefined;
                attrs?: undefined;
            } | {
                type: string;
                text: string;
                marks: {
                    type: string;
                }[];
                attrs?: undefined;
            } | {
                type: string;
                text: string;
                marks: {
                    type: string;
                    attrs: {
                        color: string;
                    };
                }[];
                attrs?: undefined;
            } | {
                type: string;
                attrs: {
                    latex: string;
                };
                text?: undefined;
                marks?: undefined;
            })[];
        } | {
            type: string;
            attrs: {
                blockId: string;
                level?: undefined;
                anchor?: undefined;
                emoji?: undefined;
                tone?: undefined;
                language?: undefined;
            };
            content: {
                type: string;
                attrs: {
                    blockId: string;
                };
                content: ({
                    type: string;
                    attrs: {
                        blockId: string;
                    };
                    content: {
                        type: string;
                        text: string;
                    }[];
                } | {
                    type: string;
                    attrs: {
                        blockId: string;
                    };
                    content: {
                        type: string;
                        attrs: {
                            blockId: string;
                        };
                        content: {
                            type: string;
                            attrs: {
                                blockId: string;
                            };
                            content: {
                                type: string;
                                text: string;
                            }[];
                        }[];
                    }[];
                })[];
            }[];
        } | {
            type: string;
            attrs: {
                blockId: string;
                level?: undefined;
                anchor?: undefined;
                emoji?: undefined;
                tone?: undefined;
                language?: undefined;
            };
            content: {
                type: string;
                attrs: {
                    blockId: string;
                    checked: boolean;
                };
                content: {
                    type: string;
                    attrs: {
                        blockId: string;
                    };
                    content: {
                        type: string;
                        text: string;
                    }[];
                }[];
            }[];
        } | {
            type: string;
            attrs: {
                blockId: string;
                emoji: string;
                tone: string;
                level?: undefined;
                anchor?: undefined;
                language?: undefined;
            };
            content: {
                type: string;
                attrs: {
                    blockId: string;
                };
                content: {
                    type: string;
                    text: string;
                }[];
            }[];
        } | {
            type: string;
            attrs: {
                blockId: string;
                level?: undefined;
                anchor?: undefined;
                emoji?: undefined;
                tone?: undefined;
                language?: undefined;
            };
            content: ({
                type: string;
                content: {
                    type: string;
                    attrs: {
                        backgroundColor: string;
                    };
                    content: {
                        type: string;
                        attrs: {
                            blockId: string;
                        };
                        content: {
                            type: string;
                            text: string;
                            marks: {
                                type: string;
                            }[];
                        }[];
                    }[];
                }[];
            } | {
                type: string;
                content: {
                    type: string;
                    attrs: {
                        backgroundColor: string;
                    };
                    content: {
                        type: string;
                        attrs: {
                            blockId: string;
                        };
                        content: {
                            type: string;
                            text: string;
                        }[];
                    }[];
                }[];
            })[];
        } | {
            type: string;
            attrs: {
                blockId: string;
                level?: undefined;
                anchor?: undefined;
                emoji?: undefined;
                tone?: undefined;
                language?: undefined;
            };
            content: ({
                type: string;
                attrs: {
                    blockId: string;
                    widthRatio: number;
                };
                content: {
                    type: string;
                    attrs: {
                        blockId: string;
                    };
                    content: {
                        type: string;
                        text: string;
                        marks: {
                            type: string;
                        }[];
                    }[];
                }[];
            } | {
                type: string;
                attrs: {
                    blockId: string;
                    widthRatio: number;
                };
                content: {
                    type: string;
                    attrs: {
                        blockId: string;
                    };
                    content: {
                        type: string;
                        text: string;
                    }[];
                }[];
            })[];
        } | {
            type: string;
            attrs: {
                blockId: string;
                language: string;
                level?: undefined;
                anchor?: undefined;
                emoji?: undefined;
                tone?: undefined;
            };
            content: {
                type: string;
                text: string;
            }[];
        })[];
    };
};
//# sourceMappingURL=fixture.d.ts.map