import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('matrix_folders')
export class MatrixFolderEntity {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  parentId!: string | null;

  @Column({ type: 'int', default: 0 })
  order!: number;

  @Column({ type: 'varchar', length: 64 })
  createdAt!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  updatedAt!: string;
}
